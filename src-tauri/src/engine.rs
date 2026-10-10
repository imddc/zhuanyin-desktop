//! 转写引擎：常驻的 whisper.cpp 上下文 + 转写编排。
//!
//! 与旧实现的根本区别：
//! - 不再起 Python 子进程、不再依赖用户自装的 mlx-whisper，推理在进程内完成；
//! - 不再依赖外部 ffmpeg，音频解码在 `audio.rs` 里用纯 Rust 完成；
//! - 模型上下文**常驻内存**：切模型才重新加载，连续转写多个文件不会反复付加载成本；
//! - 进度、分段、取消都走 whisper.cpp 的原生回调，不再靠正则解析子进程的 stdout。
//!
//! 核心函数 [`transcribe`] 刻意不依赖 Tauri：界面与无头 CLI 走的是同一条路径，
//! 验收脚本因此能测到真实实现，而不是另写一套近似逻辑。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use whisper_rs::{
    FullParams, SamplingStrategy, SegmentCallbackData, WhisperContext, WhisperContextParameters,
};

use crate::audio;
use crate::history::{HistoryStore, NewHistoryEntry};
use crate::models::{ModelRegistry, ModelSpec};
use crate::output::{self, Segment};

/// 表示「让引擎自己判断语言」。
pub const LANGUAGE_AUTO: &str = "auto";

// ---------------------------------------------------------------------------
// 引擎核心（不依赖 Tauri）
// ---------------------------------------------------------------------------

/// 解码完成后的音频信息。
#[derive(Clone, Debug)]
pub struct AudioInfo {
    pub duration: f64,
    pub source_rate: u32,
    pub source_channels: usize,
}

/// 转写过程中的观察者。界面与 CLI 各自实现一份，核心逻辑不关心谁来听。
/// 推理开始之前的阶段。
///
/// 这两个阶段都**不产生进度**，但都可能要好几秒：加载模型要读几百 MB，
/// 解码要把整段音频解成 16 kHz 单声道。以前这段时间界面上什么都没发生，
/// 看起来就像卡住了 —— 所以单独报出来，让界面能说一句「正在解码」。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscribePhase {
    /// 加载模型（本会话第一次转写才会走）
    LoadingModel,
    /// 把音频解码成 16 kHz 单声道
    DecodingAudio,
}

pub trait TranscribeObserver: Send {
    /// 进入某个准备阶段
    fn on_phase(&mut self, _phase: TranscribePhase) {}
    /// 音频已解码，推理即将开始
    fn on_audio(&mut self, _info: &AudioInfo) {}
    /// 识别出一段
    fn on_segment(&mut self, _segment: &Segment, _ratio: f64) {}
    /// 比分段更细的进度
    fn on_progress(&mut self, _ratio: f64) {}
}

/// 转写结果。
pub struct TranscribeOutcome {
    pub segments: Vec<Segment>,
    pub text: String,
    pub files: HashMap<String, String>,
    pub language: String,
    pub duration: f64,
    pub elapsed_seconds: f64,
}

/// 转写失败原因。取消是正常路径，不该当成错误展示给用户。
pub enum TranscribeFailure {
    Canceled,
    Failed(String),
}

impl TranscribeFailure {
    pub fn message(&self) -> String {
        match self {
            TranscribeFailure::Canceled => "已取消".to_string(),
            TranscribeFailure::Failed(message) => message.clone(),
        }
    }
}

/// 一次转写的输入与输出参数。
///
/// 收成一个结构体而不是排一长串参数：调用点读起来更像一句话，
/// 加字段时也不用动每一处调用。
pub struct TranscribeJob<'a> {
    pub audio_path: &'a Path,
    pub out_dir: &'a Path,
    /// 产物文件名（不含扩展名），同时作为产物子目录名
    pub name: &'a str,
    /// [`LANGUAGE_AUTO`] 表示自动检测
    pub language: &'a str,
    /// 初始提示词；`None` 表示不传
    pub prompt: Option<&'a str>,
}

/// 引擎核心：解码 → 推理 → 落盘。
///
/// `cancel` 被置位时，whisper.cpp 会在下一个检查点退出。
pub fn transcribe<O: TranscribeObserver + 'static>(
    context: &WhisperContext,
    job: TranscribeJob<'_>,
    cancel: Arc<AtomicBool>,
    mut observer: O,
) -> Result<TranscribeOutcome, TranscribeFailure> {
    // 解码整段音频要几秒（长文件更久），先告诉界面现在在干什么
    observer.on_phase(TranscribePhase::DecodingAudio);
    let decoded = audio::decode_to_16k(job.audio_path).map_err(TranscribeFailure::Failed)?;
    let duration = decoded.duration_seconds();

    let observer = Arc::new(Mutex::new(observer));
    observer
        .lock()
        .map_err(|_| TranscribeFailure::Failed("观察者已损坏".into()))?
        .on_audio(&AudioInfo {
            duration,
            source_rate: decoded.source_rate,
            source_channels: decoded.source_channels,
        });

    let mut state = context
        .create_state()
        .map_err(|error| TranscribeFailure::Failed(format!("无法初始化识别状态：{error}")))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
    // 语言：auto 传 None 让 whisper.cpp 自己判断；指定时显式传，省掉一次检测。
    //
    // 这里**绝不能**设 detect_language —— whisper.cpp 里那条分支是：
    //     if (language == null || detect_language) {
    //         检测语言; params.language = 结果;
    //         if (detect_language) return 0;      // ← 只检测，直接返回
    //     }
    // 也就是说 detect_language 的语义是「只做语言检测然后结束」，不是「检测完再转写」。
    // 同时设 None + detect_language 会让整段音频一次都没送进解码器，
    // 结果是「任务成功、0 段、产物全空」—— 整个默认路径静默失效。
    //
    // 传 None 且不开 detect_language 时，它会检测完继续转写，检测结果落在
    // state->lang_id 上，后面 detected_language() 照常拿得到。
    params.set_language(if job.language == LANGUAGE_AUTO {
        None
    } else {
        Some(job.language)
    });
    params.set_detect_language(false);
    params.set_translate(false);
    // 不把上一段文本当下一段的提示：实测这样最不容易在结尾打转
    params.set_no_context(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_n_threads(inference_threads());
    if let Some(prompt) = job.prompt {
        params.set_initial_prompt(prompt);
    }

    // 收集到的分段同时用于事件与落盘
    let collected: Arc<Mutex<Vec<Segment>>> = Arc::new(Mutex::new(Vec::new()));

    let segment_observer = Arc::clone(&observer);
    let segment_sink = Arc::clone(&collected);
    params.set_segment_callback_safe(move |data: SegmentCallbackData| {
        let text = data.text.trim().to_string();
        let start = data.start_timestamp as f64 / 100.0;
        let end = data.end_timestamp as f64 / 100.0;

        // 模型偶尔吐空段：不写进列表（否则界面出现空行），但仍要推进进度
        let segment = Segment { start, end, text };
        if !segment.text.is_empty() {
            if let Ok(mut list) = segment_sink.lock() {
                list.push(segment.clone());
            }
        }

        let ratio = if duration > 0.0 {
            (end / duration).clamp(0.0, 0.999)
        } else {
            0.0
        };
        if let Ok(mut observer) = segment_observer.lock() {
            observer.on_segment(&segment, ratio);
        }
    });

    let progress_observer = Arc::clone(&observer);
    params.set_progress_callback_safe(move |percent: i32| {
        let ratio = (percent as f64 / 100.0).clamp(0.0, 0.999);
        if let Ok(mut observer) = progress_observer.lock() {
            observer.on_progress(ratio);
        }
    });

    // 取消：不走 whisper-rs 的 set_abort_callback_safe —— 它在 0.16.0 里把双重装箱的闭包
    // 按具体类型解引用（`trampoline::<F>`），而 progress / segment 的包装用的都是
    // `trampoline::<Box<dyn ...>>`。类型对不上就会踩内存，实测直接段错误。
    // 这里绕过安全包装，自己传一个只读 AtomicBool 的 C 回调。
    //
    // SAFETY：回调只读取 `cancel_handle` 指向的 AtomicBool，不做任何其他事；
    // `cancel_handle` 在本函数结束前一直存活，指针不会悬空。
    unsafe extern "C" fn abort_trampoline(user_data: *mut std::ffi::c_void) -> bool {
        if user_data.is_null() {
            return false;
        }
        let flag = unsafe { &*(user_data as *const AtomicBool) };
        flag.load(Ordering::SeqCst)
    }

    let cancel_handle = Arc::clone(&cancel);
    unsafe {
        params.set_abort_callback(Some(abort_trampoline));
        params.set_abort_callback_user_data(Arc::as_ptr(&cancel_handle) as *mut std::ffi::c_void);
    }

    let started = std::time::Instant::now();
    let outcome = state.full(params, &decoded.samples);
    let elapsed_seconds = started.elapsed().as_secs_f64();
    // 指针已经不需要了，显式结束借用关系，让「生命周期够长」这件事无歧义
    drop(cancel_handle);

    if cancel.load(Ordering::SeqCst) {
        return Err(TranscribeFailure::Canceled);
    }
    outcome.map_err(|error| TranscribeFailure::Failed(format!("识别失败：{error}")))?;

    let segments = collected
        .lock()
        .map(|list| list.clone())
        .unwrap_or_default();
    let text = segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<String>()
        .trim()
        .to_string();

    let resolved_language = if job.language == LANGUAGE_AUTO {
        detected_language(&state)
    } else {
        job.language.to_string()
    };

    let files = output::write_outputs(
        job.out_dir,
        job.name,
        &text,
        &resolved_language,
        duration,
        &segments,
    )
    .map_err(TranscribeFailure::Failed)?;

    Ok(TranscribeOutcome {
        segments,
        text,
        files,
        language: resolved_language,
        duration,
        elapsed_seconds,
    })
}

/// 自动检测出的语言代码；取不到就退回 `auto`。
fn detected_language(state: &whisper_rs::WhisperState) -> String {
    let id = state.full_lang_id_from_state();
    if id < 0 {
        return LANGUAGE_AUTO.to_string();
    }
    let pointer = unsafe { whisper_rs::whisper_rs_sys::whisper_lang_str(id) };
    if pointer.is_null() {
        return LANGUAGE_AUTO.to_string();
    }
    unsafe { std::ffi::CStr::from_ptr(pointer) }
        .to_string_lossy()
        .to_string()
}

/// 加载模型上下文。CLI 与界面共用。
pub fn load_context(path: &Path) -> Result<WhisperContext, String> {
    WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|error| format!("加载模型失败（{}）：{error}", path.display()))
}

/// 推理线程数。whisper.cpp 在 Metal 下仍会用 CPU 做部分计算，取物理并行度并封顶。
fn inference_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4)
        .clamp(1, 8) as i32
}

// ---------------------------------------------------------------------------
// 应用级状态
// ---------------------------------------------------------------------------

/// 应用级状态。所有需要跨命令共享的东西都挂在这里。
pub struct AppState {
    pub models: Arc<ModelRegistry>,
    pub history: Arc<HistoryStore>,
    /// 常驻模型。切模型时才重新加载。
    engine: Mutex<LoadedModel>,
    /// 进行中任务的取消旗标
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 任务号的自增序号（前端通常自带 id，这里只是兜底）
    sequence: AtomicU64,
}

impl AppState {
    pub fn new(models: Arc<ModelRegistry>, history: Arc<HistoryStore>) -> Self {
        Self {
            models,
            history,
            engine: Mutex::new(LoadedModel::default()),
            jobs: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
        }
    }

    /// 卸下常驻模型（模型被删除或替换时调用），让下次转写重新加载。
    pub fn forget_loaded_model(&self, model_id: &str) {
        if let Ok(mut engine) = self.engine.lock() {
            if engine.model_id.as_deref() == Some(model_id) {
                engine.model_id = None;
                engine.context = None;
            }
        }
    }

    /// 释放常驻模型。
    ///
    /// 必须在**进程退出之前**调用：ggml 的 Metal 设备是个带静态析构的全局对象，
    /// 它析构时会断言「residency set 必须已经空」：
    ///
    /// ```c
    /// // ggml-metal-device.m
    /// // note: if you hit this assert, most likely you haven't deallocated
    /// //       all Metal resources before exiting
    /// GGML_ASSERT([rsets->data count] == 0);
    /// ```
    ///
    /// 界面把模型常驻在这里、一直不释放，于是静态析构跑的时候 Metal 资源还挂着，
    /// 断言失败 → abort（实测每次退出都崩）。
    /// CLI 走同一条 `transcribe` 却不崩，因为它的 context 是局部变量、退出前就 drop 了。
    pub fn release_loaded_model(&self) {
        if let Ok(mut engine) = self.engine.lock() {
            engine.model_id = None;
            engine.context = None;
        }
    }
}

#[derive(Default)]
struct LoadedModel {
    model_id: Option<String>,
    context: Option<Arc<WhisperContext>>,
}

/// 引擎缺失项。code 给前端判断，message 给用户看。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineIssue {
    pub code: String,
    pub message: String,
}

/// 引擎状态：这一版「能不能跑」等价于「有没有可用的模型」。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub ready: bool,
    /// 模型目录，界面里要能直接打开它
    pub models_dir: String,
    /// 已下载的模型数量
    pub available_models: usize,
    /// 当前常驻在内存里的模型
    pub loaded_model_id: Option<String>,
    pub issues: Vec<EngineIssue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    pub input: String,
    /// 由前端指定任务号：事件可能早于 invoke 返回，前端自带 id 才能直接对上
    pub job_id: Option<String>,
    pub out_dir: Option<String>,
    pub name: Option<String>,
    /// 用哪个模型；不传则回退到「已下载的推荐模型」
    pub model_id: Option<String>,
    /// 语言代码；`auto`、空值或不传都表示自动检测
    pub language: Option<String>,
    /// 初始提示词。留空则不传——实测长术语表会让模型复读提示词。
    pub prompt: Option<String>,
}

// ---------------------------------------------------------------------------
// 事件载荷
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobMeta {
    job_id: String,
    name: String,
    source: String,
    duration: f64,
    model_id: String,
    model_name: String,
    language: String,
    /// 源采样率与声道数：界面上显示「源 44.1 kHz 立体声」，出问题时一眼能看出是不是解码环节
    source_rate: u32,
    source_channels: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobSegment {
    job_id: String,
    start: f64,
    end: f64,
    text: String,
    ratio: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    job_id: String,
    ratio: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobDone {
    job_id: String,
    name: String,
    duration: f64,
    language: String,
    segments: usize,
    files: HashMap<String, String>,
    text: String,
    history_id: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobError {
    job_id: String,
    message: String,
}

/// 准备阶段事件：这段时间没有进度可报，但界面要能说明它在干什么。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobPhase {
    job_id: String,
    phase: TranscribePhase,
}

/// 把转写过程翻译成 `asr://` 事件。
///
/// `on_audio` 不在这里实现：meta 事件还要带任务名与模型信息，由 [`NamingObserver`] 补齐。
struct TauriObserver {
    app: AppHandle,
    job_id: String,
}

impl TranscribeObserver for TauriObserver {
    fn on_segment(&mut self, segment: &Segment, ratio: f64) {
        let _ = self.app.emit(
            "asr://segment",
            JobSegment {
                job_id: self.job_id.clone(),
                start: segment.start,
                end: segment.end,
                text: segment.text.clone(),
                ratio,
            },
        );
    }

    fn on_phase(&mut self, phase: TranscribePhase) {
        let _ = self.app.emit(
            "asr://phase",
            JobPhase {
                job_id: self.job_id.clone(),
                phase,
            },
        );
    }

    fn on_progress(&mut self, ratio: f64) {
        let _ = self.app.emit(
            "asr://progress",
            JobProgress {
                job_id: self.job_id.clone(),
                ratio,
            },
        );
    }
}

/// 无头 CLI 用的观察者：把进度打到 stderr，不干扰 stdout 的结果输出。
struct CliObserver;

impl TranscribeObserver for CliObserver {
    fn on_phase(&mut self, phase: TranscribePhase) {
        let label = match phase {
            TranscribePhase::LoadingModel => "加载模型",
            TranscribePhase::DecodingAudio => "解码音频",
        };
        eprintln!("   准备：{label}");
    }

    fn on_audio(&mut self, info: &AudioInfo) {
        eprintln!(
            "   音频 {:.1}s · 源 {} Hz / {} 声道",
            info.duration, info.source_rate, info.source_channels
        );
    }

    fn on_segment(&mut self, segment: &Segment, _ratio: f64) {
        eprintln!(
            "   [{:7.2} → {:7.2}] {}",
            segment.start, segment.end, segment.text
        );
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 探测引擎状态。
#[tauri::command]
pub fn engine_status(state: State<'_, AppState>) -> EngineStatus {
    let statuses = state.models.list();
    let available = statuses.iter().filter(|item| item.downloaded).count();

    let loaded_model_id = state
        .engine
        .lock()
        .ok()
        .and_then(|engine| engine.model_id.clone());

    let mut issues = Vec::new();
    if available == 0 {
        issues.push(EngineIssue {
            code: "model".to_string(),
            message: "还没有可用的模型。在下方模型列表里选一个下载即可开始使用。".to_string(),
        });
    }

    EngineStatus {
        ready: available > 0,
        models_dir: state.models.root().display().to_string(),
        available_models: available,
        loaded_model_id,
        issues,
    }
}

/// 启动一个转写任务，立即返回任务号；进度通过 asr:// 事件推送。
#[tauri::command]
pub fn start_transcribe(
    app: AppHandle,
    state: State<'_, AppState>,
    request: TranscribeRequest,
) -> Result<String, String> {
    let input = PathBuf::from(&request.input);
    if !input.is_file() {
        return Err(format!("找不到音频文件：{}", input.display()));
    }

    let model = resolve_model(&state.models, request.model_id.as_deref())?;

    let job_id = request.job_id.unwrap_or_else(|| {
        format!(
            "{}-{}",
            std::process::id(),
            state.sequence.fetch_add(1, Ordering::SeqCst) + 1
        )
    });

    let name = request.name.unwrap_or_else(|| {
        input
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "transcript".to_string())
    });

    let out_dir = resolve_out_dir(&input, request.out_dir.as_deref().map(Path::new), &name);
    let language = normalize_language(request.language.as_deref());
    let prompt = request
        .prompt
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let cancel = Arc::new(AtomicBool::new(false));
    state
        .jobs
        .lock()
        .map_err(|_| "任务表已损坏".to_string())?
        .insert(job_id.clone(), cancel.clone());

    let thread_app = app.clone();
    let thread_job = job_id.clone();

    std::thread::spawn(move || {
        run_job(
            thread_app, thread_job, input, name, out_dir, model, language, prompt, cancel,
        );
    });

    Ok(job_id)
}

/// 取消进行中的任务。设置旗标即可——whisper.cpp 的 abort 回调会在下一步退出。
#[tauri::command]
pub fn cancel_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    let flag = state
        .jobs
        .lock()
        .map_err(|_| "任务表已损坏".to_string())?
        .get(&job_id)
        .cloned();

    if let Some(flag) = flag {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// 在文件管理器里定位文件。
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    reveal(Path::new(&path))
}

/// 在文件管理器里定位路径（文件或目录都行）。
pub fn reveal(target: &Path) -> Result<(), String> {
    if !target.exists() {
        return Err(format!("路径不存在：{}", target.display()));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut value = std::process::Command::new("open");
        value.arg("-R").arg(target);
        value
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut value = std::process::Command::new("explorer");
        value.arg(format!("/select,{}", target.display()));
        value
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut value = std::process::Command::new("xdg-open");
        match target.parent() {
            Some(parent) => value.arg(parent),
            None => value.arg(target),
        };
        value
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开失败：{error}"))
}

/// 挑一个可用的模型：优先用前端指定的，否则用「已下载的推荐模型」，再否则用唯一一个已下载的。
fn resolve_model(registry: &ModelRegistry, requested: Option<&str>) -> Result<ModelSpec, String> {
    if let Some(id) = requested {
        let spec = registry.find(id).ok_or_else(|| format!("未知模型：{id}"))?;
        if !registry.path_of(spec).is_file() {
            return Err(format!("模型「{}」还没有下载", spec.name));
        }
        return Ok(spec.clone());
    }

    let downloaded: Vec<ModelSpec> = registry
        .catalog()
        .iter()
        .filter(|spec| registry.path_of(spec).is_file())
        .cloned()
        .collect();

    match downloaded.len() {
        0 => Err("还没有可用的模型，请先在模型列表里下载一个".to_string()),
        1 => Ok(downloaded[0].clone()),
        _ => Ok(downloaded
            .iter()
            .find(|spec| spec.recommended)
            .cloned()
            .unwrap_or_else(|| downloaded[0].clone())),
    }
}

/// `auto`、空串与缺省都归一成「自动检测」。
pub fn normalize_language(language: Option<&str>) -> String {
    match language.map(str::trim) {
        None | Some("") | Some(LANGUAGE_AUTO) => LANGUAGE_AUTO.to_string(),
        Some(value) => value.to_string(),
    }
}

/// 一个任务从解码到落盘的完整流程。在独立线程里跑，不阻塞界面。
#[allow(clippy::too_many_arguments)]
fn run_job(
    app: AppHandle,
    job_id: String,
    input: PathBuf,
    name: String,
    out_dir: PathBuf,
    model: ModelSpec,
    language: String,
    prompt: Option<String>,
    cancel: Arc<AtomicBool>,
) {
    let finish = |app: &AppHandle, job_id: &str| {
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut jobs) = state.jobs.lock() {
                jobs.remove(job_id);
            }
        }
        let _ = app.emit("asr://finished", job_id.to_string());
    };

    // meta 事件里的名称与模型信息由这里补齐：核心层不该知道这些展示细节。
    // 必须在 ensure_context 之前建好 —— 加载模型本身也是要报出来的准备阶段。
    let mut observer = NamingObserver {
        inner: TauriObserver {
            app: app.clone(),
            job_id: job_id.clone(),
        },
        name: name.clone(),
        source: input.display().to_string(),
        model_id: model.id.clone(),
        model_name: model.name.clone(),
        language: language.clone(),
    };

    observer.on_phase(TranscribePhase::LoadingModel);
    let context = match ensure_context(&app, &model) {
        Ok(context) => context,
        Err(message) => {
            let _ = app.emit(
                "asr://error",
                JobError {
                    job_id: job_id.clone(),
                    message,
                },
            );
            finish(&app, &job_id);
            return;
        }
    };

    let outcome = match transcribe(
        &context,
        TranscribeJob {
            audio_path: &input,
            out_dir: &out_dir,
            name: &name,
            language: &language,
            prompt: prompt.as_deref(),
        },
        cancel,
        observer,
    ) {
        Ok(outcome) => outcome,
        Err(TranscribeFailure::Canceled) => {
            // 用户主动取消：前端已经把它标成已取消，这里不再报错
            finish(&app, &job_id);
            return;
        }
        Err(failure) => {
            let _ = app.emit(
                "asr://error",
                JobError {
                    job_id: job_id.clone(),
                    message: failure.message(),
                },
            );
            finish(&app, &job_id);
            return;
        }
    };

    // 落历史。失败不该影响「转写已经成功」这个事实，所以只忽略错误。
    let history_id = app.try_state::<AppState>().and_then(|state| {
        state
            .history
            .record(NewHistoryEntry {
                name: name.clone(),
                source_path: input.display().to_string(),
                output_dir: out_dir.display().to_string(),
                model_id: model.id.clone(),
                language: outcome.language.clone(),
                duration_seconds: outcome.duration,
                text: outcome.text.clone(),
                segments: outcome.segments.clone(),
                files: outcome.files.clone(),
            })
            .ok()
    });

    log_summary(
        &name,
        outcome.duration,
        outcome.elapsed_seconds,
        outcome.segments.len(),
    );

    let _ = app.emit(
        "asr://done",
        JobDone {
            job_id: job_id.clone(),
            name,
            duration: outcome.duration,
            language: outcome.language,
            segments: outcome.segments.len(),
            files: outcome.files,
            text: outcome.text,
            history_id,
        },
    );

    finish(&app, &job_id);
}

/// 在 `TauriObserver` 外面补上任务名与模型信息。
///
/// 核心层只知道「音频多长、识别出了什么」，展示层的字段由这一层填，
/// 免得把界面概念（模型名、源路径）渗进引擎。
struct NamingObserver {
    inner: TauriObserver,
    name: String,
    source: String,
    model_id: String,
    model_name: String,
    language: String,
}

impl TranscribeObserver for NamingObserver {
    fn on_phase(&mut self, phase: TranscribePhase) {
        self.inner.on_phase(phase);
    }

    fn on_audio(&mut self, info: &AudioInfo) {
        let _ = self.inner.app.emit(
            "asr://meta",
            JobMeta {
                job_id: self.inner.job_id.clone(),
                name: self.name.clone(),
                source: self.source.clone(),
                duration: info.duration,
                model_id: self.model_id.clone(),
                model_name: self.model_name.clone(),
                language: self.language.clone(),
                source_rate: info.source_rate,
                source_channels: info.source_channels,
            },
        );
    }

    fn on_segment(&mut self, segment: &Segment, ratio: f64) {
        self.inner.on_segment(segment, ratio);
    }

    fn on_progress(&mut self, ratio: f64) {
        self.inner.on_progress(ratio);
    }
}

/// 取出常驻上下文；模型换了才重新加载。
fn ensure_context(app: &AppHandle, model: &ModelSpec) -> Result<Arc<WhisperContext>, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "应用状态不可用".to_string())?;

    let mut engine = state
        .engine
        .lock()
        .map_err(|_| "引擎状态已损坏".to_string())?;

    if engine.model_id.as_deref() == Some(model.id.as_str()) {
        if let Some(context) = engine.context.clone() {
            return Ok(context);
        }
    }

    let path = state.models.path_of(model);
    if !path.is_file() {
        return Err(format!("模型文件不存在：{}", path.display()));
    }

    let context = Arc::new(load_context(&path)?);
    engine.model_id = Some(model.id.clone());
    engine.context = Some(Arc::clone(&context));
    Ok(context)
}

/// 每个任务打一行摘要，便于从日志复盘速度。
fn log_summary(name: &str, duration: f64, elapsed_seconds: f64, segments: usize) {
    let speed = if elapsed_seconds > 0.0 {
        duration / elapsed_seconds
    } else {
        0.0
    };
    println!(
        "[转音] {name}：{duration:.1}s 音频 / {elapsed_seconds:.1}s 推理（{speed:.1}× 实时）/ {segments} 段"
    );
}

/// 无头 CLI 的入口：解码 → 推理 → 落盘，不启动界面。
///
/// 存在的意义有两个：验收脚本能测到与界面完全相同的引擎路径；
/// 用户也能拿它脚本化批量转写（`zhuanyin --transcribe a.m4a`）。
pub fn run_headless(
    audio: &Path,
    model_path: &Path,
    out_dir: Option<&Path>,
    name: Option<&str>,
    language: Option<&str>,
    prompt: Option<&str>,
    json: bool,
) -> Result<(), String> {
    let name = name
        .map(str::to_string)
        .or_else(|| {
            audio
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "transcript".to_string());

    let out_dir = resolve_out_dir(audio, out_dir, &name);
    let language = normalize_language(language);
    let prompt = prompt.map(str::trim).filter(|value| !value.is_empty());

    eprintln!("== 加载模型 ==");
    let started = std::time::Instant::now();
    let context = load_context(model_path)?;
    eprintln!("   {} ms", started.elapsed().as_millis());

    eprintln!("== 转写 ==");
    // 无头模式没有界面可点取消，但保留这条通道：将来接信号或 Ctrl+C 都不用改核心
    let cancel = Arc::new(AtomicBool::new(false));
    let outcome = transcribe(
        &context,
        TranscribeJob {
            audio_path: audio,
            out_dir: &out_dir,
            name: &name,
            language: &language,
            prompt,
        },
        cancel,
        CliObserver,
    )
    .map_err(|failure| failure.message())?;

    let speed = if outcome.elapsed_seconds > 0.0 {
        outcome.duration / outcome.elapsed_seconds
    } else {
        0.0
    };

    if json {
        let payload = serde_json::json!({
            "name": name,
            "duration": outcome.duration,
            "language": outcome.language,
            "segments": outcome.segments.len(),
            "files": outcome.files,
            "text": outcome.text,
            "elapsedSeconds": outcome.elapsed_seconds,
            "speed": speed,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&payload)
                .map_err(|error| format!("序列化结果失败：{error}"))?
        );
    } else {
        println!("{}", outcome.text);
    }

    eprintln!(
        "\n✓ 完成：{:.1}s 音频 / {:.1}s 推理（{:.1}× 实时）/ {} 段 → {}",
        outcome.duration,
        outcome.elapsed_seconds,
        speed,
        outcome.segments.len(),
        out_dir.display()
    );

    Ok(())
}

/// 产物目录：`<根目录>/<任务名>/`，一个任务一个文件夹。
///
/// 根目录优先用前端传进来的（用户在界面上选了输出位置），否则用音频所在目录 ——
/// 这样默认行为仍然可预期：产物就在音频旁边，只是收进一个同名文件夹。
fn resolve_out_dir(input: &Path, requested_root: Option<&Path>, name: &str) -> PathBuf {
    let root = requested_root
        .map(Path::to_path_buf)
        .or_else(|| input.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    root.join(safe_name(name))
}

/// 把任务名净化成安全的目录名。
///
/// 任务名来自用户拖进来的文件名，直接拿去拼路径的话，一次转写就能把产物写到目录外
/// （`../x`、`a/b`），所以路径分隔符、控制字符一律替换掉，再去掉首尾空白与点号。
fn safe_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '_',
            other if other.is_control() => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "transcript".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_language, resolve_out_dir, safe_name, LANGUAGE_AUTO};
    use std::path::Path;

    #[test]
    fn treats_missing_and_auto_as_automatic_detection() {
        assert_eq!(normalize_language(None), LANGUAGE_AUTO);
        assert_eq!(normalize_language(Some("")), LANGUAGE_AUTO);
        assert_eq!(normalize_language(Some("   ")), LANGUAGE_AUTO);
        assert_eq!(normalize_language(Some("auto")), LANGUAGE_AUTO);
    }

    #[test]
    fn keeps_explicit_language_codes() {
        assert_eq!(normalize_language(Some("zh")), "zh");
        assert_eq!(normalize_language(Some(" en ")), "en");
    }

    #[test]
    fn falls_back_to_the_audio_directory() {
        let dir = resolve_out_dir(Path::new("/music/interview.m4a"), None, "interview");
        assert_eq!(dir, Path::new("/music/interview"));
    }

    #[test]
    fn prefers_the_requested_root() {
        let dir = resolve_out_dir(
            Path::new("/music/interview.m4a"),
            Some(Path::new("/out")),
            "interview",
        );
        assert_eq!(dir, Path::new("/out/interview"));
    }

    #[test]
    fn keeps_human_readable_names() {
        assert_eq!(safe_name("2026 年终复盘"), "2026 年终复盘");
        assert_eq!(safe_name("  interview  "), "interview");
    }

    #[test]
    fn strips_path_separators() {
        assert_eq!(safe_name("a/b"), "a_b");
        assert_eq!(safe_name("a\\b"), "a_b");
        assert_eq!(safe_name("C:meeting"), "C_meeting");
    }

    #[test]
    fn refuses_to_climb_out_of_the_directory() {
        assert_eq!(safe_name(".."), "transcript");
        assert_eq!(safe_name("../etc/passwd"), "_etc_passwd");
        assert_eq!(safe_name("   "), "transcript");
        assert_eq!(safe_name(""), "transcript");
    }
}
