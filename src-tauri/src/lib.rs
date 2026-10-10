//! 应用装配：创建模型目录与历史库，注册全部命令。
//!
//! 这一版不再需要探测 Python / 模型目录 / ffmpeg 三项本机依赖 ——
//! 引擎编译进了应用，解码在进程内完成，用户唯一要准备的东西是「一个模型」。
//!
//! 同一个可执行文件还带一个无头模式（`--transcribe`）：验收脚本用它测到与界面
//! 完全相同的引擎路径，用户也可以拿它脚本化批量转写。

mod audio;
mod engine;
mod history;
mod models;
mod output;
mod windows;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::Manager;

use engine::AppState;
use history::HistoryStore;
use models::ModelRegistry;

/// 启动失败时把可读信息带出去。setup 只接受 `Box<dyn Error>`，
/// 而我们的底层错误都是 String，这里统一包一层。
fn boot_error(message: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::other(message))
}

const USAGE: &str = "\
转音 · 本机离线语音转写

用法：
  转音                                       启动图形界面
  转音 --transcribe <音频> [选项]              无头转写，不开界面
  转音 --download-model <模型 id> [选项]       无头下载模型，校验 sha256 后落盘

选项：
  --model <路径|模型 id>   指定模型；给 id 时在模型目录里找（无头模式必填）
  --models-dir <目录>      模型目录，默认与应用使用同一个位置
  --out-dir <目录>         产物根目录，默认与音频同目录
  --name <名称>            产物文件名，默认取音频文件名
  --language <代码>        zh / en / auto …，默认 auto（自动检测）
  --prompt <文本>          初始提示词，默认不传
  --json                   以 JSON 输出结果（供脚本消费）
  -h, --help               显示本说明
";

/// 从命令行解析出的一次无头调用。
#[derive(Debug)]
struct HeadlessArgs {
    audio: PathBuf,
    model: String,
    models_dir: Option<PathBuf>,
    out_dir: Option<PathBuf>,
    name: Option<String>,
    language: Option<String>,
    prompt: Option<String>,
    json: bool,
}

/// 解析结果。解析是纯函数，不产生副作用，执行交给 [`run`]。
#[derive(Debug)]
enum CliCommand {
    /// 没有无头参数，启动图形界面
    LaunchGui,
    PrintUsage,
    Transcribe(Box<HeadlessArgs>),
    /// 无头下载一个模型（与界面里的下载同一条实现）
    DownloadModel {
        id: String,
        models_dir: Option<PathBuf>,
    },
}

/// 解析命令行。只认 `--transcribe`，其余情况一律回到图形界面。
fn parse_cli(args: &[String]) -> Result<CliCommand, String> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        return Ok(CliCommand::PrintUsage);
    }

    // 值型参数统一按「选项后面紧跟取值」解析
    let value_of = |flag: &str| -> Option<String> {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let flag_set = |flag: &str| args.iter().any(|arg| arg == flag);

    // 无头下载模型：让「第一次使用」这件事也能在脚本里复现与验证
    if let Some(id) = value_of("--download-model") {
        return Ok(CliCommand::DownloadModel {
            id,
            models_dir: value_of("--models-dir").map(PathBuf::from),
        });
    }

    let Some(position) = args.iter().position(|arg| arg == "--transcribe") else {
        return Ok(CliCommand::LaunchGui);
    };

    let audio = args
        .get(position + 1)
        .filter(|value| !value.starts_with("--"))
        .map(PathBuf::from)
        .ok_or_else(|| "--transcribe 后面要跟音频文件路径".to_string())?;

    let model = value_of("--model")
        .ok_or_else(|| "无头模式必须用 --model 指定模型（路径或模型 id）".to_string())?;

    Ok(CliCommand::Transcribe(Box::new(HeadlessArgs {
        audio,
        model,
        models_dir: value_of("--models-dir").map(PathBuf::from),
        out_dir: value_of("--out-dir").map(PathBuf::from),
        name: value_of("--name"),
        language: value_of("--language"),
        prompt: value_of("--prompt"),
        json: flag_set("--json"),
    })))
}

/// 无头模式默认的模型目录，与应用运行时用的是同一个。
///
/// 这里手写路径而不是问 Tauri：无头模式没有 AppHandle，而且它必须在
/// `tauri::Builder` 之前就能跑（脚本里不该为了转一个文件去初始化 webview）。
fn default_models_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join("Library/Application Support/com.imddc.zhuanyin/models");
        }
    }
    PathBuf::from("models")
}

/// 执行一次无头转写。
fn run_headless(args: &HeadlessArgs) -> Result<(), String> {
    if !args.audio.is_file() {
        return Err(format!("找不到音频文件：{}", args.audio.display()));
    }

    // --model 既接受文件路径，也接受清单里的模型 id
    let registry = ModelRegistry::new(args.models_dir.clone().unwrap_or_else(default_models_dir));
    let model_path = {
        let given = Path::new(&args.model);
        if given.is_file() {
            given.to_path_buf()
        } else if let Some(spec) = registry.find(&args.model) {
            let path = registry.path_of(spec);
            if !path.is_file() {
                return Err(format!(
                    "模型「{}」还没有下载，先启动界面下载，或改用 --model 指定模型文件",
                    spec.name
                ));
            }
            path
        } else {
            return Err(format!(
                "--model 既不是文件，也不在模型清单里：{}",
                args.model
            ));
        }
    };

    engine::run_headless(
        &args.audio,
        &model_path,
        args.out_dir.as_deref(),
        args.name.as_deref(),
        args.language.as_deref(),
        args.prompt.as_deref(),
        args.json,
    )
}

pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    match parse_cli(&args) {
        Ok(CliCommand::LaunchGui) => {}
        Ok(CliCommand::PrintUsage) => {
            println!("{USAGE}");
            return;
        }
        Ok(CliCommand::Transcribe(headless)) => {
            if let Err(message) = run_headless(&headless) {
                eprintln!("✗ {message}");
                std::process::exit(1);
            }
            return;
        }
        Ok(CliCommand::DownloadModel { id, models_dir }) => {
            let target = models_dir.unwrap_or_else(default_models_dir);
            eprintln!("== 下载模型 {id} ==");
            match models::download_headless(&target, &id) {
                Ok(path) => eprintln!("✓ 已就绪：{}", path.display()),
                Err(message) => {
                    eprintln!("✗ {message}");
                    std::process::exit(1);
                }
            }
            return;
        }
        Err(message) => {
            eprintln!("✗ {message}\n\n{USAGE}");
            std::process::exit(2);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| boot_error(format!("无法定位应用数据目录：{error}")))?;

            let models = Arc::new(ModelRegistry::new(data_dir.join("models")));
            let history =
                Arc::new(HistoryStore::open(&data_dir.join("history.db")).map_err(boot_error)?);

            // 有模型就直接开工作区；没有就先只开引导窗口 ——
            // 两者是不同的东西，不该挤在同一个窗口里靠覆盖层切换。
            if models.list().iter().any(|item| item.downloaded) {
                windows::create_main_window(app.handle())?;
            } else {
                windows::create_onboarding_window(app.handle())?;
            }

            app.manage(AppState::new(models, history));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != windows::ONBOARDING_LABEL {
                return;
            }
            if matches!(event, tauri::WindowEvent::Destroyed)
                && window
                    .app_handle()
                    .get_webview_window(windows::MAIN_LABEL)
                    .is_none()
            {
                // 引导没走完（没有模型）时用户关掉了引导窗口。
                //
                // 这里**不打开主窗口**：主窗口必须等引导完成之后才出现，
                // 否则就成了「没有模型也能进主界面」，跟引导的先后顺序是矛盾的。
                // 也不留一个没有窗口的进程，直接退出；下次启动还会回到引导。
                // 正常点「开始使用」时主窗口已经先建好，不会走到这里。
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_status,
            engine::start_transcribe,
            engine::cancel_job,
            engine::reveal_in_file_manager,
            models::list_models,
            models::download_model,
            models::cancel_model_download,
            models::delete_model,
            models::import_model,
            models::models_dir,
            history::list_history,
            history::get_history_entry,
            history::delete_history_entry,
            history::clear_history,
            windows::finish_onboarding,
            windows::open_onboarding
        ])
        .build(tauri::generate_context!())
        .expect("转音启动失败")
        .run(|app, event| {
            // 退出前显式释放常驻模型。
            //
            // 不这么做的话，模型持有的 Metal 资源会活到进程退出，ggml 的静态析构
            // 断言失败直接 abort —— 表现就是「应用每次退出都崩」。
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.release_loaded_model();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{parse_cli, CliCommand};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    /// 从解析结果里取出无头参数，顺便断言它确实是转写命令。
    fn expect_transcribe(values: &[&str]) -> super::HeadlessArgs {
        match parse_cli(&args(values)).unwrap() {
            CliCommand::Transcribe(headless) => *headless,
            _ => panic!("期望解析成无头转写：{values:?}"),
        }
    }

    #[test]
    fn launches_the_gui_when_no_headless_flag_is_present() {
        assert!(matches!(
            parse_cli(&args(&[])).unwrap(),
            CliCommand::LaunchGui
        ));
    }

    #[test]
    fn prints_usage_for_help() {
        assert!(matches!(
            parse_cli(&args(&["--help"])).unwrap(),
            CliCommand::PrintUsage
        ));
        assert!(matches!(
            parse_cli(&args(&["-h"])).unwrap(),
            CliCommand::PrintUsage
        ));
    }

    #[test]
    fn requires_a_model_in_headless_mode() {
        let error = parse_cli(&args(&["--transcribe", "/tmp/a.m4a"])).unwrap_err();
        assert!(error.contains("--model"), "错误信息要指出缺什么：{error}");
    }

    #[test]
    fn requires_an_audio_path_after_the_flag() {
        let error = parse_cli(&args(&["--transcribe"])).unwrap_err();
        assert!(error.contains("音频文件路径"), "实际：{error}");
    }

    #[test]
    fn rejects_a_flag_used_as_the_audio_path() {
        // `--transcribe --model x` 是漏写音频路径，不该把它当成文件名
        assert!(parse_cli(&args(&["--transcribe", "--model", "x"])).is_err());
    }

    #[test]
    fn parses_every_option() {
        let headless = expect_transcribe(&[
            "--transcribe",
            "/tmp/a.m4a",
            "--model",
            "large-v3-turbo-q5_0",
            "--models-dir",
            "/tmp/models",
            "--out-dir",
            "/tmp/out",
            "--name",
            "meeting",
            "--language",
            "zh",
            "--prompt",
            "会议记录",
            "--json",
        ]);

        assert_eq!(headless.audio.to_str().unwrap(), "/tmp/a.m4a");
        assert_eq!(headless.model, "large-v3-turbo-q5_0");
        assert_eq!(
            headless.models_dir.unwrap().to_str().unwrap(),
            "/tmp/models"
        );
        assert_eq!(headless.out_dir.unwrap().to_str().unwrap(), "/tmp/out");
        assert_eq!(headless.name.unwrap(), "meeting");
        assert_eq!(headless.language.unwrap(), "zh");
        assert_eq!(headless.prompt.unwrap(), "会议记录");
        assert!(headless.json);
    }

    #[test]
    fn optional_flags_default_to_absent() {
        let headless = expect_transcribe(&["--transcribe", "/tmp/a.m4a", "--model", "/tmp/m.bin"]);

        assert!(headless.out_dir.is_none());
        assert!(headless.name.is_none());
        assert!(headless.language.is_none());
        assert!(headless.prompt.is_none());
        assert!(!headless.json);
    }
}
