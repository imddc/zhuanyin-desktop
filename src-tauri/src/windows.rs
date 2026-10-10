//! 窗口管理。
//!
//! 首次使用的引导是**独立窗口**，不复用主窗口：没有可用模型时只创建引导窗口，
//! 主窗口此时根本不存在；等模型就绪，用户点「开始使用」才建主窗口、关掉引导窗口。
//!
//! 这样做的理由：两者是不同性质的东西 —— 一个是「设置向导」（窗口小、可关闭、
//! 关掉就意味着用户放弃），一个是「工作区」（窗口大、要长期开着）。
//! 用同一个窗口靠覆盖层切换，会让主窗口在引导阶段白白存在并跑着一整套界面逻辑。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 工作区窗口。
pub const MAIN_LABEL: &str = "main";
/// 首次使用引导窗口。
pub const ONBOARDING_LABEL: &str = "onboarding";

/// 创建工作区窗口。
///
/// 选项与之前写在 `tauri.conf.json` 里的一致，只是改成按需创建。
pub fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    println!("[转音] 打开窗口：{MAIN_LABEL}");
    let builder = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        // 原生层禁用生产 Web Inspector；前端快捷键拦截不能替代这个开关。
        .devtools(cfg!(debug_assertions))
        .title("转音 · 本机语音转写")
        .inner_size(1280.0, 860.0)
        .min_inner_size(980.0, 640.0)
        .resizable(true);
    // 拖拽投放默认就是开的（WindowConfig::drag_drop_enabled 默认为 true），
    // 主窗口要接住拖进来的音频文件，所以这里不做任何关闭处理。
    // 注意：builder 上的 drag_and_drop() 只在 Windows 编译，别拿它来「确保开启」。

    // 无边框标题栏 + 红绿灯位置是 macOS 专有 API，别的平台保持系统默认
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));

    builder.build()
}

/// 创建引导窗口。
///
/// 无边框，由前端自绘一条标题带（拖动区 + 关闭按钮）——跟主窗口的无边框视觉一致，
/// 也去掉系统红绿灯。代价是拖动与关闭都得自己做，前端那条 `.onboarding__bar` 就是补这个的，
/// 而且无边框窗口在 macOS 上拿不到系统级缩放手柄，尺寸按内容定死。
///
/// 关掉这个窗口不再意味着「应用退出」：如果此时还没有模型，会把主窗口开出来 ——
/// 那边有「还没有可用模型」的说明和去模型页下载的入口，路是通的。
pub fn create_onboarding_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    println!("[转音] 打开窗口：{ONBOARDING_LABEL}");
    WebviewWindowBuilder::new(app, ONBOARDING_LABEL, WebviewUrl::App("index.html".into()))
        .devtools(cfg!(debug_assertions))
        .title("转音 · 初次设置")
        .inner_size(880.0, 720.0)
        .min_inner_size(720.0, 560.0)
        .decorations(false)
        // 窗口本身透明，圆角由前端那张卡片的 border-radius 裁出来 ——
        // 不透明窗口在 macOS 上只有直角，做不出圆角
        .transparent(true)
        .center()
        .build()
}

/// 引导完成：确保工作区窗口在，然后关掉引导窗口。
#[tauri::command]
pub fn finish_onboarding(app: AppHandle) -> Result<(), String> {
    // 先建主窗口再关引导：反过来的话，引导窗口销毁时主窗口还不存在，
    // 会被 on_window_event 判成「用户放弃引导」而直接退出应用。
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.show();
        let _ = main.set_focus();
    } else {
        create_main_window(&app).map_err(|error| format!("无法打开主窗口：{error}"))?;
    }

    if let Some(onboarding) = app.get_webview_window(ONBOARDING_LABEL) {
        let _ = onboarding.close();
    }

    Ok(())
}

/// 重新打开引导窗口（设置页里用）。已经开着就只是聚焦。
#[tauri::command]
pub fn open_onboarding(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(ONBOARDING_LABEL) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    create_onboarding_window(&app).map_err(|error| format!("无法打开引导窗口：{error}"))?;
    Ok(())
}
