//! 模型目录与应用内下载。
//!
//! 设计要点（都是「开箱即用」直接依赖的）：
//! - 清单编译进二进制（`include_str!`），不依赖运行时下载清单文件；
//! - `sha256` 是唯一的信任锚：镜像只是加速通道，校验不过就删掉重下；
//! - 支持断点续传（`Range` + `.part`），并有**停滞看门狗**——长时间收不到字节直接失败，
//!   而不是像无超时的请求那样永远挂着（国内直连 huggingface.co 就是这种静默停滞）；
//! - 用户本机已有的模型不会被重复下载：先扫描模型目录，也支持把已有文件导入。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;

use crate::engine::AppState;

/// 清单文件编译进二进制：应用启动不需要联网就能知道有哪些模型可选。
const CATALOG_JSON: &str = include_str!("catalog.json");

/// 单个分片写盘的最大时长之外，多久收不到字节就算停滞。
const DOWNLOAD_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// 建立连接的超时。国内直连 huggingface.co 会卡在连接阶段，必须快速失败好切镜像。
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
/// 每个源最多尝试几次（每次都会从已下载的字节继续）。
const MAX_ATTEMPTS_PER_SOURCE: usize = 3;

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub id: String,
    pub name: String,
    pub description: String,
    pub filename: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub multilingual: bool,
    pub recommended: bool,
    pub speed_score: u8,
    pub accuracy_score: u8,
}

#[derive(Deserialize)]
struct CatalogFile {
    models: Vec<ModelSpec>,
}

/// 前端展示用的模型状态：清单条目 + 本机是否已下载。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    #[serde(flatten)]
    pub spec: ModelSpec,
    pub downloaded: bool,
    pub downloading: bool,
    /// 已下载字节（含未完成的 partial），用于显示进度
    pub downloaded_bytes: u64,
    pub path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    ratio: f64,
    source: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadFailure {
    id: String,
    message: String,
}

/// 下载过程中的事件接收者。
///
/// 抽出这一层是为了让「应用内下载」与「无头下载」走完全相同的代码：
/// 界面把事件翻译成 Tauri 事件，CLI 打到 stderr。下载器本身不认识 UI。
pub trait DownloadObserver: Send {
    /// 已下载字节数变化
    fn on_progress(&mut self, downloaded: u64, total: u64, source: &str);
    /// 开始校验 sha256
    fn on_verifying(&mut self) {}
}

/// 模型清单与下载状态。
pub struct ModelRegistry {
    root: PathBuf,
    catalog: Vec<ModelSpec>,
    /// 每个模型的取消旗标；取消后下载任务在下一个分片处退出
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl ModelRegistry {
    /// 以 `<app_data>/models` 为模型根目录。
    pub fn new(root: PathBuf) -> Self {
        let catalog = serde_json::from_str::<CatalogFile>(CATALOG_JSON)
            .map(|file| file.models)
            .unwrap_or_default();

        Self {
            root,
            catalog,
            cancels: Mutex::new(HashMap::new()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn catalog(&self) -> &[ModelSpec] {
        &self.catalog
    }

    pub fn find(&self, id: &str) -> Option<&ModelSpec> {
        self.catalog.iter().find(|spec| spec.id == id)
    }

    /// 某个模型的完整落盘路径。
    pub fn path_of(&self, spec: &ModelSpec) -> PathBuf {
        self.root.join(&spec.filename)
    }

    fn partial_of(&self, spec: &ModelSpec) -> PathBuf {
        self.root.join(format!("{}.part", spec.filename))
    }

    /// 列出全部模型及其本机状态。
    pub fn list(&self) -> Vec<ModelStatus> {
        let active = self
            .cancels
            .lock()
            .map(|map| map.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();

        self.catalog
            .iter()
            .map(|spec| {
                let final_path = self.path_of(spec);
                let downloaded = final_path.is_file();
                let partial_bytes = std::fs::metadata(self.partial_of(spec))
                    .map(|meta| meta.len())
                    .unwrap_or(0);

                ModelStatus {
                    spec: spec.clone(),
                    downloaded,
                    downloading: active.iter().any(|id| id == &spec.id),
                    downloaded_bytes: if downloaded {
                        spec.size_bytes
                    } else {
                        partial_bytes
                    },
                    path: downloaded.then(|| final_path.display().to_string()),
                }
            })
            .collect()
    }

    /// 把用户已有的模型文件收进模型目录。
    ///
    /// 同卷优先用硬链接：不复制 500 MB，也几乎瞬时完成；跨卷再退回复制。
    pub fn import(&self, source: &Path) -> Result<String, String> {
        if !source.is_file() {
            return Err(format!("找不到模型文件：{}", source.display()));
        }

        let name = source
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .ok_or_else(|| "无法识别文件名".to_string())?;

        std::fs::create_dir_all(&self.root)
            .map_err(|error| format!("无法创建模型目录：{error}"))?;
        let target = self.root.join(&name);

        if target.is_file() {
            return Ok(target.display().to_string());
        }

        // 先硬链接，失败（跨卷或文件系统不支持）再复制
        if std::fs::hard_link(source, &target).is_err() {
            std::fs::copy(source, &target).map_err(|error| format!("导入模型失败：{error}"))?;
        }

        Ok(target.display().to_string())
    }

    /// 删除模型（连同未完成的 partial）。
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let spec = self.find(id).ok_or_else(|| format!("未知模型：{id}"))?;
        for path in [self.path_of(spec), self.partial_of(spec)] {
            if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|error| format!("删除失败 {}：{error}", path.display()))?;
            }
        }
        Ok(())
    }

    fn register_cancel(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.cancels.lock() {
            map.insert(id.to_string(), flag.clone());
        }
        flag
    }

    fn clear_cancel(&self, id: &str) {
        if let Ok(mut map) = self.cancels.lock() {
            map.remove(id);
        }
    }

    /// 请求取消下载。设置旗标即可，下载循环会在下一个分片处退出并保留 partial。
    pub fn cancel_download(&self, id: &str) -> bool {
        match self.cancels.lock() {
            Ok(map) => match map.get(id) {
                Some(flag) => {
                    flag.store(true, Ordering::SeqCst);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    /// 启动下载（异步），进度通过 `model://download` 事件推送。
    pub fn start_download(self: &Arc<Self>, app: AppHandle, id: String) -> Result<(), String> {
        let spec = self
            .find(&id)
            .cloned()
            .ok_or_else(|| format!("未知模型：{id}"))?;

        if self.path_of(&spec).is_file() {
            return Err(format!("{} 已经下载过了", spec.name));
        }
        if self
            .cancels
            .lock()
            .map(|map| map.contains_key(&id))
            .unwrap_or(false)
        {
            return Err(format!("{} 正在下载中", spec.name));
        }

        let cancel = self.register_cancel(&id);
        let registry = Arc::clone(self);

        tauri::async_runtime::spawn(async move {
            let mut observer = TauriDownloadObserver {
                app: app.clone(),
                id: id.clone(),
            };
            let result = registry.run_download(&spec, &cancel, &mut observer).await;
            registry.clear_cancel(&id);

            match result {
                Ok(()) => {
                    let _ = app.emit(
                        "model://download-done",
                        serde_json::json!({
                            "id": id,
                            "path": registry.path_of(&spec).display().to_string(),
                        }),
                    );
                }
                Err(message) => {
                    let _ = app.emit("model://download-error", DownloadFailure { id, message });
                }
            }
        });

        Ok(())
    }

    /// 依次尝试各个源，每个源内部带重试与断点续传。
    pub(crate) async fn run_download<O: DownloadObserver>(
        &self,
        spec: &ModelSpec,
        cancel: &AtomicBool,
        observer: &mut O,
    ) -> Result<(), String> {
        std::fs::create_dir_all(&self.root)
            .map_err(|error| format!("无法创建模型目录：{error}"))?;

        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            // 不用整体超时：几百 MB 的下载本来就要几分钟，靠停滞看门狗判断「卡死」
            .build()
            .map_err(|error| format!("初始化下载器失败：{error}"))?;

        let mut last_error = String::from("没有可用的下载源");

        for url in model_urls(&spec.filename) {
            for attempt in 1..=MAX_ATTEMPTS_PER_SOURCE {
                if cancel.load(Ordering::SeqCst) {
                    return Err("已取消".to_string());
                }

                match self
                    .download_from(spec, cancel, &client, &url, attempt, observer)
                    .await
                {
                    Ok(()) => return Ok(()),
                    Err(DownloadError::Canceled) => return Err("已取消".to_string()),
                    Err(DownloadError::Failed(message)) => {
                        last_error = format!("{url}：{message}");
                    }
                }
            }
        }

        Err(last_error)
    }

    /// 从单个地址下载（可续传）。
    async fn download_from<O: DownloadObserver>(
        &self,
        spec: &ModelSpec,
        cancel: &AtomicBool,
        client: &reqwest::Client,
        url: &str,
        attempt: usize,
        observer: &mut O,
    ) -> Result<(), DownloadError> {
        let partial = self.partial_of(spec);
        let existing = tokio::fs::metadata(&partial)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);

        // 已经下满就不必再请求
        if existing >= spec.size_bytes {
            return self
                .finish_download(spec, &partial, observer)
                .await
                .map_err(DownloadError::Failed);
        }

        let mut request = client.get(url);
        if existing > 0 {
            request = request.header("Range", format!("bytes={existing}-"));
        }

        let response = request
            .send()
            .await
            .map_err(|error| DownloadError::Failed(format!("请求失败：{error}")))?;

        if !response.status().is_success() {
            // 206 = 从中间续传；416 = 本地已完整（理论上前面已拦）
            return Err(DownloadError::Failed(format!(
                "服务返回 {}",
                response.status()
            )));
        }

        let resumed = response.status().as_u16() == 206;
        let start_offset = if resumed { existing } else { 0 };
        let total = response.content_length().unwrap_or(0) + start_offset;
        let total = total.max(spec.size_bytes);

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&partial)
            .await
            .map_err(|error| DownloadError::Failed(format!("打开文件失败：{error}")))?;

        let mut written = start_offset;
        let mut stream = response.bytes_stream();
        let mut last_emit = std::time::Instant::now();

        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = file.flush().await;
                return Err(DownloadError::Canceled);
            }

            // 停滞看门狗：超过时限收不到任何字节即认为这个源不可用
            let chunk = match tokio::time::timeout(DOWNLOAD_STALL_TIMEOUT, stream.next()).await {
                Ok(Some(Ok(chunk))) => chunk,
                Ok(Some(Err(error))) => {
                    let _ = file.flush().await;
                    return Err(DownloadError::Failed(format!("传输中断：{error}")));
                }
                Ok(None) => break,
                Err(_) => {
                    let _ = file.flush().await;
                    return Err(DownloadError::Failed(format!(
                        "{} 秒内没有收到数据，判定为停滞",
                        DOWNLOAD_STALL_TIMEOUT.as_secs()
                    )));
                }
            };

            file.write_all(&chunk)
                .await
                .map_err(|error| DownloadError::Failed(format!("写入失败：{error}")))?;
            written += chunk.len() as u64;

            // 高频回调会拖慢渲染（也会刷爆终端），限流到约 5 次/秒
            if last_emit.elapsed() >= std::time::Duration::from_millis(200) {
                last_emit = std::time::Instant::now();
                observer.on_progress(written, total, url);
            }
        }

        file.flush()
            .await
            .map_err(|error| DownloadError::Failed(format!("落盘失败：{error}")))?;
        drop(file);

        let actual = tokio::fs::metadata(&partial)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);
        if actual < spec.size_bytes {
            // 收到结束但字节不够：当作这个源失败，下次重试会从这里继续
            return Err(DownloadError::Failed(format!(
                "只收到 {actual} / {} 字节（第 {attempt} 次尝试）",
                spec.size_bytes
            )));
        }

        self.finish_download(spec, &partial, observer)
            .await
            .map_err(DownloadError::Failed)
    }

    /// 校验 sha256 并改名为正式文件。
    async fn finish_download<O: DownloadObserver>(
        &self,
        spec: &ModelSpec,
        partial: &Path,
        observer: &mut O,
    ) -> Result<(), String> {
        observer.on_verifying();

        let actual = hash_file(partial).await?;
        if actual != spec.sha256 {
            // 校验不过就删掉：留着只会让用户以为已经下好了
            let _ = tokio::fs::remove_file(partial).await;
            return Err(format!(
                "校验不通过（期望 {}，实际 {}），已删除不完整的文件",
                &spec.sha256[..12.min(spec.sha256.len())],
                &actual[..12.min(actual.len())]
            ));
        }

        let target = self.path_of(spec);
        tokio::fs::rename(partial, &target)
            .await
            .map_err(|error| format!("归档模型失败：{error}"))?;

        Ok(())
    }
}

enum DownloadError {
    Canceled,
    Failed(String),
}

/// 把下载进度翻译成 `model://download` 事件。
struct TauriDownloadObserver {
    app: AppHandle,
    id: String,
}

impl DownloadObserver for TauriDownloadObserver {
    fn on_progress(&mut self, downloaded: u64, total: u64, source: &str) {
        let _ = self.app.emit(
            "model://download",
            DownloadProgress {
                id: self.id.clone(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                ratio: if total > 0 {
                    (downloaded as f64 / total as f64).clamp(0.0, 1.0)
                } else {
                    0.0
                },
                source: source.to_string(),
            },
        );
    }

    fn on_verifying(&mut self) {
        let _ = self
            .app
            .emit("model://verifying", serde_json::json!({ "id": self.id }));
    }
}

/// 无头下载的观察者：进度覆盖在同一行打到 stderr，不干扰 stdout 的结果输出。
#[derive(Default)]
struct CliDownloadObserver {
    last_percent: u64,
    last_width: usize,
}

impl DownloadObserver for CliDownloadObserver {
    fn on_progress(&mut self, downloaded: u64, total: u64, source: &str) {
        let percent = (downloaded * 100).checked_div(total).unwrap_or(0);
        // 百分比没变就不重画，避免把终端刷爆
        if percent == self.last_percent {
            return;
        }
        self.last_percent = percent;

        let line = format!(
            "   {percent:3}%  {} / {}  ← {}",
            format_bytes(downloaded),
            format_bytes(total),
            host_of(source)
        );
        let width = line.chars().count();
        eprint!("\r{line}");
        self.last_width = width;
    }

    fn on_verifying(&mut self) {
        let pad = " ".repeat(self.last_width.min(80));
        eprint!("\r{pad}\r");
        eprintln!("   校验 sha256…");
    }
}

/// 字节数 → 可读体积（命令行进度用）。
fn format_bytes(bytes: u64) -> String {
    let megabytes = bytes as f64 / (1024.0 * 1024.0);
    if megabytes < 1024.0 {
        format!("{megabytes:.0} MB")
    } else {
        format!("{:.2} GB", megabytes / 1024.0)
    }
}

/// 从 URL 里取主机名，让进度行能看出当前在用哪个源。
fn host_of(url: &str) -> String {
    url.split("//")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or(url)
        .to_string()
}

/// 无头下载一个模型。
///
/// 与界面里的下载走的是同一个 `run_download`，所以这里验证过的行为
/// （续传、停滞看门狗、sha256 校验、换源）在界面里同样成立。
pub fn download_headless(models_dir: &Path, id: &str) -> Result<PathBuf, String> {
    let registry = Arc::new(ModelRegistry::new(models_dir.to_path_buf()));
    let spec = registry
        .find(id)
        .ok_or_else(|| format!("未知模型：{id}"))?
        .clone();

    let target = registry.path_of(&spec);
    if target.is_file() {
        // 幂等：已经下过就直接返回，脚本里可以无脑重跑
        return Ok(target);
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let mut observer = CliDownloadObserver::default();
    tauri::async_runtime::block_on(registry.run_download(&spec, &cancel, &mut observer))?;

    Ok(target)
}

/// 分块算 sha256。几百 MB 也就一两秒，不必边下边算（续传时还要重新对齐）。
async fn hash_file(path: &Path) -> Result<String, String> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("读取文件失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];

    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("读取文件失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// 一个模型文件的候选下载地址，按优先级排列。
///
/// 镜像放在前面是有意的：这个产品的用户以中文场景为主，而 huggingface.co
/// 在国内直连会静默停滞。sha256 由清单内置，镜像无法替换内容。
fn model_urls(filename: &str) -> Vec<String> {
    const UPSTREAM: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
    const MIRROR: &str = "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main";
    vec![
        format!("{MIRROR}/{filename}"),
        format!("{UPSTREAM}/{filename}"),
    ]
}

// ---------------------------------------------------------------------------
// 暴露给前端的命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_models(state: State<'_, AppState>) -> Vec<ModelStatus> {
    state.models.list()
}

#[tauri::command]
pub fn download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.models.start_download(app, id)
}

#[tauri::command]
pub fn cancel_model_download(state: State<'_, AppState>, id: String) -> bool {
    state.models.cancel_download(&id)
}

#[tauri::command]
pub fn delete_model(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.models.delete(&id)?;
    // 删掉的如果正是内存里常驻的那个，必须一起卸下：否则界面显示已删除，
    // 引擎却还在拿内存里的旧模型转写，用户会以为删除没生效。
    state.forget_loaded_model(&id);
    Ok(())
}

/// 模型目录路径。
///
/// 主窗口从 `engine_status` 里拿到同一个值；引导窗口不关心引擎状态，
/// 只需要这一个路径，所以单独给一条。
#[tauri::command]
pub fn models_dir(state: State<'_, AppState>) -> String {
    state.models.root().display().to_string()
}

/// 导入用户已有的模型文件（同卷走硬链接，不复制几百 MB）。
#[tauri::command]
pub fn import_model(state: State<'_, AppState>, path: String) -> Result<String, String> {
    state.models.import(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::{
        hash_file, model_urls, CatalogFile, DownloadObserver, ModelRegistry, CATALOG_JSON,
    };
    use std::path::PathBuf;

    fn registry() -> ModelRegistry {
        ModelRegistry::new(PathBuf::from("/tmp/zhuanyin-model-test"))
    }

    /// 只用来满足签名，不关心事件。
    struct NullObserver;

    impl DownloadObserver for NullObserver {
        fn on_progress(&mut self, _downloaded: u64, _total: u64, _source: &str) {}
    }

    #[test]
    fn catalog_parses_and_is_not_empty() {
        let parsed: CatalogFile = serde_json::from_str(CATALOG_JSON).expect("清单必须能解析");
        assert!(!parsed.models.is_empty(), "清单不能是空的");
    }

    #[test]
    fn catalog_has_exactly_one_recommended_model() {
        // 推荐项是首次启动的默认选择，多于一个会让用户不知道选哪个
        let recommended: Vec<_> = registry()
            .catalog()
            .iter()
            .filter(|spec| spec.recommended)
            .map(|spec| spec.id.clone())
            .collect();
        assert_eq!(recommended.len(), 1, "推荐模型应恰好一个：{recommended:?}");
    }

    #[test]
    fn every_catalog_entry_carries_a_full_sha256() {
        // sha256 是唯一信任锚，缺了就退化成「无校验下载」
        for spec in registry().catalog() {
            assert_eq!(
                spec.sha256.len(),
                64,
                "{} 的 sha256 长度不对：{}",
                spec.id,
                spec.sha256
            );
            assert!(
                spec.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{} 的 sha256 含非十六进制字符",
                spec.id
            );
        }
    }

    #[test]
    fn every_catalog_entry_declares_a_plausible_size() {
        // 体积要和文件名对得上：tiny 不该比 large 大
        let registry = registry();
        let tiny = registry.find("tiny-q5_1").unwrap();
        let large = registry.find("large-v3-turbo-q5_0").unwrap();
        assert!(tiny.size_bytes < large.size_bytes);
        assert!(large.size_bytes > 500_000_000);
    }

    #[test]
    fn mirrors_come_before_upstream() {
        let urls = model_urls("ggml-tiny-q5_1.bin");
        assert_eq!(urls.len(), 2, "应当有主源与备用源");
        assert!(
            urls[0].contains("hf-mirror.com"),
            "镜像必须排在前面：国内直连上游会静默停滞"
        );
        assert!(urls[1].contains("huggingface.co"));
    }

    #[test]
    fn unknown_model_id_is_rejected() {
        assert!(registry().find("does-not-exist").is_none());
    }

    #[test]
    fn listing_reports_nothing_downloaded_on_a_fresh_machine() {
        let statuses = registry().list();
        assert_eq!(statuses.len(), registry().catalog().len());
        // 用不会存在的文件名，避免本机恰好装过时误判
        assert!(statuses
            .iter()
            .all(|status| status.path.is_none() || status.downloaded));
    }

    /// 信任锚的底座：必须对**完整字节**求解。多读或少读一个字节，校验就失去意义。
    #[test]
    fn hash_file_matches_the_known_digest_of_a_payload() {
        let dir = std::env::temp_dir().join("zhuanyin-hash-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("payload.bin");
        std::fs::write(&path, b"zhuanyin").unwrap();

        let actual = tauri::async_runtime::block_on(hash_file(&path)).unwrap();
        assert_eq!(
            actual, "e603b4ad4b623c06fd0730189abe30de0bdf48013be7b3b60275321086618a70",
            "sha256 结果与已知值不符，说明读取范围不对"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 整个模型分发的安全前提：镜像只是加速通道，内容不对就必须拒绝，
    /// 而且不能把坏文件留在磁盘上冒充「已下载」。
    #[test]
    fn finish_download_rejects_a_payload_whose_hash_does_not_match() {
        let dir = std::env::temp_dir().join("zhuanyin-verify-test");
        let _ = std::fs::remove_dir_all(&dir);

        let registry = ModelRegistry::new(dir.clone());
        let spec = registry
            .find("tiny-q5_1")
            .expect("清单里必须有 tiny-q5_1")
            .clone();
        let partial = registry.partial_of(&spec);

        std::fs::create_dir_all(&dir).unwrap();
        // 内容与真实权重毫无关系，所以只有 sha256 能发现它
        std::fs::write(&partial, vec![0u8; 4096]).unwrap();

        let mut observer = NullObserver;
        let result = tauri::async_runtime::block_on(registry.finish_download(
            &spec,
            &partial,
            &mut observer,
        ));

        let message = result.expect_err("哈希不符时必须报错");
        assert!(
            message.contains("校验不通过"),
            "错误信息要说清是校验失败，而不是含糊的失败：{message}"
        );
        assert!(!partial.exists(), "校验不通过的文件必须被删除");
        assert!(
            !registry.path_of(&spec).exists(),
            "坏文件绝不能被归档成模型"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
