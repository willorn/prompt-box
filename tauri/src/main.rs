// PromptBox Tauri 主进程（阶段 3：系统集成）
// 对照 Electron main.js 的核心行为：菜单栏常驻、Alt+E 唤起、offscreen 隐藏、粘贴主路径、
// 导入导出 / 安全快照 / 登录自启 / prepare-quit 退出流。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// helpers 为 prompt-helpers.js 全量平价移植：主进程实际只走 sanitize/指纹/格式探测，
// 其余（解析/搜索/评分/高亮）由 renderer 的 JS 版承担，Rust 侧作为对等参照由单测消费。
#[allow(dead_code)]
mod helpers;
mod paste;
mod store;
mod webdav;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

// Electron GLOBAL_HOTKEY_CANDIDATES 的 Tauri 等价写法（Option+Command+P → Alt+Command+P）
const HOTKEY_CANDIDATES: &[&str] = &[
    "Alt+E",
    "Alt+Space",
    "Alt+Command+P",
    "Command+Shift+Period",
    "Command+Shift+.",
];

#[derive(Clone, Default)]
struct PasteTarget {
    name: String,
    pid: i64,
}

struct AppState {
    // 失焦抑制窗口（毫秒时间戳）：对话框/托盘交互期间不自动隐藏
    suppress_blur_hide_until: AtomicU64,
    // 管理弹层锁定（基线 38/52）：锁定期间非强制隐藏只通知 renderer
    blur_hide_locked: AtomicBool,
    // offscreen 待命态：窗口存活但移出可视区（保持 webview 不重载）
    hidden_offscreen: AtomicBool,
    // 剪贴板恢复（基线 51）：2.8s 后恢复原剪贴板；新调用先收尾旧的
    restore_generation: AtomicU64,
    pending_restore: Mutex<Option<(String, String)>>,
    // 唤起时记录的会话粘贴目标 + 上次成功目标（基线 31/54）
    session_paste_target: Mutex<PasteTarget>,
    last_success_target: Mutex<PasteTarget>,
    active_hotkey: Mutex<String>,
    store: Mutex<store::Store>,
    // 退出流程（对齐 before-quit）：prepare-quit → 渲染层刷保存 → prepare-quit-done → 收尾退出
    quitting: AtomicBool,
    quit_confirmed: AtomicBool,
}

// —— 辅助函数（非命令）——

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

// 主题跟随：Chromium 自动跟随系统外观，WKWebView 的 prefers-color-scheme 不可靠，
// 显式 set_theme 对齐（同时驱动标题栏外观与 CSS 媒体查询）。
// 检测方式：Light 模式下 AppleInterfaceStyle 键不存在（defaults 报错），Dark 返回 "Dark"。
fn sync_system_theme(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    let dark = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "Dark")
        .unwrap_or(false);
    let theme = if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    };
    let _ = win.set_theme(Some(theme));
}

fn set_blur_suppress_window(state: &AppState, ms: u64) {
    let until = paste::now_ms() as u64 + ms.max(300);
    state.suppress_blur_hide_until.store(until, Ordering::SeqCst);
}

fn blur_hide_suppressed(state: &AppState) -> bool {
    (paste::now_ms() as u64) < state.suppress_blur_hide_until.load(Ordering::SeqCst)
}

fn hotkey_info_value(app: &AppHandle) -> Value {
    let state = app.state::<AppState>();
    let preferred = state
        .store
        .lock()
        .unwrap()
        .get_pref("preferredGlobalHotkey")
        .and_then(|v| v.as_str().map(String::from))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Alt+E".to_string());
    let active = state.active_hotkey.lock().unwrap().clone();
    let active = if active.is_empty() { preferred.clone() } else { active };
    json!({
        "preferred": preferred,
        "active": active,
        "activeIsFallback": active != preferred,
        "candidates": HOTKEY_CANDIDATES,
    })
}

// 偏好键优先，其余候选按序回退（基线 32：冲突自动回退）
fn setup_global_shortcut(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let _ = app.global_shortcut().unregister_all();
    let preferred = state
        .store
        .lock()
        .unwrap()
        .get_pref("preferredGlobalHotkey")
        .and_then(|v| v.as_str().map(String::from))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Alt+E".to_string());

    let mut candidates: Vec<String> = vec![preferred];
    for c in HOTKEY_CANDIDATES {
        if !candidates.iter().any(|x| x == c) {
            candidates.push(c.to_string());
        }
    }
    let mut active = String::new();
    for c in &candidates {
        if app.global_shortcut().register(c.as_str()).is_ok() {
            active = c.clone();
            break;
        }
    }
    *state.active_hotkey.lock().unwrap() = active.clone();
    active
}

// —— 原生对话框（阶段 3）——
// osascript display dialog 等价 Electron dialog.showMessageBox（AppleScript 按钮上限 3 个）。

fn dialog_escape(s: &str) -> String {
    // AppleScript 字符串字面量不允许裸换行，用 " & return & " 拼接
    paste::escape_applescript(s)
        .replace('\n', "\" & return & \"")
        .replace('\r', "")
}

fn dialog_begin(app: &AppHandle) -> bool {
    // 系统对话框独立成窗：暂时撤掉置顶，避免它落在主窗（NSPanel level）后面
    let Some(win) = main_window(app) else { return false };
    let visible = win.is_visible().unwrap_or(false);
    if visible {
        let _ = win.set_always_on_top(false);
    }
    visible
}

fn dialog_end(app: &AppHandle, was_visible: bool) {
    if !was_visible {
        return;
    }
    if app.state::<AppState>().hidden_offscreen.load(Ordering::SeqCst) {
        return;
    }
    if let Some(win) = main_window(app) {
        let _ = win.set_always_on_top(true);
    }
}

// 返回所点按钮文本；取消（Esc/取消按钮）返回 "__canceled__"
fn show_button_dialog(
    app: &AppHandle,
    title: &str,
    message: &str,
    detail: &str,
    buttons: &[&str],
    default_button: &str,
    cancel_button: Option<&str>,
) -> Result<String, String> {
    let was_visible = dialog_begin(app);
    let esc = paste::escape_applescript;
    let btn_list = buttons
        .iter()
        .map(|b| format!("\"{}\"", esc(b)))
        .collect::<Vec<_>>()
        .join(", ");
    let text = if detail.is_empty() {
        format!("\"{}\"", dialog_escape(message))
    } else {
        format!(
            "(\"{}\" & return & return & \"{}\")",
            dialog_escape(message),
            dialog_escape(detail)
        )
    };
    let mut script = format!(
        "display dialog {text} with title \"{}\" buttons {{{btn_list}}} default button \"{}\"",
        esc(title),
        esc(default_button)
    );
    if let Some(cb) = cancel_button {
        script.push_str(&format!(" cancel button \"{}\"", esc(cb)));
    }
    let result = paste::run_command("osascript", &["-e", &script], 60_000);
    dialog_end(app, was_visible);
    match result {
        Ok(out) => Ok(out
            .trim()
            .strip_prefix("button returned:")
            .unwrap_or("")
            .trim()
            .to_string()),
        Err(err) => {
            // Esc / 取消按钮：osascript 以 -128 (User canceled) 退出
            if err.contains("User canceled") || err.contains("(-128)") {
                Ok("__canceled__".to_string())
            } else {
                Err(err)
            }
        }
    }
}

// —— 托盘菜单（对齐 rebuildTrayMenu：显示/隐藏/登录自启/退出）——

fn rebuild_tray_menu(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main-tray") else { return };
    let open_at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let Ok(show_item) = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>) else { return };
    let Ok(hide_item) = MenuItem::with_id(app, "hide", "隐藏窗口", true, None::<&str>) else { return };
    let Ok(login_item) = CheckMenuItem::with_id(
        app,
        "login",
        "登录时启动",
        true,
        open_at_login,
        None::<&str>,
    ) else {
        return;
    };
    let Ok(quit_item) = MenuItem::with_id(app, "quit", "退出 PromptBox", true, None::<&str>) else {
        return;
    };
    let Ok(sep1) = PredefinedMenuItem::separator(app) else { return };
    let Ok(sep2) = PredefinedMenuItem::separator(app) else { return };
    let Ok(menu) = Menu::new(app) else { return };
    let items: [&dyn tauri::menu::IsMenuItem<_>; 6] = [
        &show_item,
        &hide_item,
        &sep1,
        &login_item,
        &sep2,
        &quit_item,
    ];
    if menu.append_items(&items).is_err() {
        return;
    }
    let _ = tray.set_menu(Some(menu));
}

fn toggle_open_at_login(app: &AppHandle) {
    let manager = app.autolaunch();
    let current = manager.is_enabled().unwrap_or(false);
    let result = if current {
        manager.disable()
    } else {
        manager.enable()
    };
    if let Err(e) = result {
        eprintln!("[prompt-box] set login item failed: {e}");
    }
    rebuild_tray_menu(app);
}

// —— 退出流程（对齐 before-quit：先让渲染层刷完保存，至多等 1.2s）——

fn request_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return; // 已在退出流程中
    }
    state.quit_confirmed.store(false, Ordering::SeqCst);
    let _ = app.emit("prepare-quit", ());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1200);
        while std::time::Instant::now() < deadline {
            if app.state::<AppState>().quit_confirmed.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
        let state = app.state::<AppState>();
        flush_restore(&app, &state); // 退出前收尾剪贴板恢复（flushClipboardRestoreIfNeeded）
        app.exit(0);
    });
}

// —— 剪贴板恢复（scheduleClipboardRestore 移植）——

fn flush_restore(app: &AppHandle, state: &AppState) {
    // 新一轮写入前收尾：剪贴板仍是上次粘贴内容时，先还原用户原剪贴板
    state.restore_generation.fetch_add(1, Ordering::SeqCst);
    let pending = state.pending_restore.lock().unwrap().take();
    if let Some((prev, pasted)) = pending {
        let cur = app.clipboard().read_text().unwrap_or_default();
        if cur == pasted {
            let _ = app.clipboard().write_text(prev);
        }
    }
}

fn schedule_restore(app: AppHandle, previous: String, pasted: String) {
    let gen = app
        .state::<AppState>()
        .restore_generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    *app
        .state::<AppState>()
        .pending_restore
        .lock()
        .unwrap() = Some((previous, pasted));
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(2800)).await;
        let state = app.state::<AppState>();
        // 期间来了新调用/手动复制：放弃本次恢复
        if state.restore_generation.load(Ordering::SeqCst) != gen {
            return;
        }
        let pending = state.pending_restore.lock().unwrap().take();
        if let Some((prev, pasted)) = pending {
            let cur = app.clipboard().read_text().unwrap_or_default();
            if cur == pasted {
                let _ = app.clipboard().write_text(prev);
            }
        }
    });
}

// —— 显示 / 隐藏（showMainWindow / hideMainWindow 移植）——

fn show_main(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    let state = app.state::<AppState>();

    // 每次唤起同步系统外观（系统可能在待命期间切换亮/暗）
    sync_system_theme(app);

    // 先记前台（仅快路径），避免记到自己（基线 45：lsappinfo 合并读取）
    let front = paste::frontmost_fast();
    *state.session_paste_target.lock().unwrap() = PasteTarget {
        name: front.name.clone(),
        pid: front.pid,
    };

    // 几何：恢复记忆 bounds；光标所在显示器，多屏跟随（基线：多屏时跟随光标）
    // Electron 的 width/height 是整窗尺寸（含标题栏）；Tauri set_size 是内容区尺寸，
    // 差一个标题栏高度，必须补偿才能与旧版外观一致。
    let scale = win.scale_factor().unwrap_or(1.0);
    let titlebar_h = match (win.outer_size(), win.inner_size()) {
        (Ok(o), Ok(i)) if o.height > i.height => {
            (o.height - i.height) as f64 / scale
        }
        _ => 28.0,
    };
    let (saved_xy, w, h) = {
        let store = state.store.lock().unwrap();
        match store.get_window_bounds() {
            // 记忆的是整窗尺寸：换算回内容区
            Some((x, y, w, h)) => (
                Some((x, y)),
                w.clamp(720.0, 4000.0) - titlebar_h,
                h.clamp(520.0, 3000.0) - titlebar_h,
            ),
            // 首启无记忆：DEFAULT_WINDOW_BOUNDS（Electron 整词语义）
            None => (None, 860.0 - titlebar_h, 600.0 - titlebar_h),
        }
    };

    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let (mx, my, mw, mh) = monitor
        .map(|m| {
            let p = m.position();
            let s = m.size();
            (
                p.x as f64 / scale,
                p.y as f64 / scale,
                s.width as f64 / scale,
                s.height as f64 / scale,
            )
        })
        .unwrap_or((0.0, 0.0, 1440.0, 900.0));

    // 记忆位置就在光标显示器内 → 原位恢复；无记忆或不在光标屏 → 挪到该屏中央
    // （对齐 placeBoundsOnCursorDisplay + Electron 首启系统居中）
    let menu_bar = 28.0;
    let (x, y) = match saved_xy {
        Some((sx, sy)) if sx >= mx && sx < mx + mw && sy >= my && sy < my + mh => (sx, sy),
        _ => (
            mx + (mw - w) / 2.0,
            my + menu_bar + ((mh - menu_bar) - h) / 2.0,
        ),
    };

    let _ = win.set_skip_taskbar(true);
    // 调用层压在全屏应用之上（基线 6）：CanJoinAllSpaces + FullScreenAuxiliary
    let _ = win.set_visible_on_all_workspaces(true);
    let _ = win.set_always_on_top(true);

    // 先显示窗口，再设置尺寸/位置
    // macOS 隐藏窗口上 set_size 可能不立即生效，先 show 确保窗口系统就绪
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let _ = win.show();

    let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
    let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    let _ = win.set_focus();

    state.hidden_offscreen.store(false, Ordering::SeqCst);
    // show/focus 抖动期不给 blur-hide 机会
    set_blur_suppress_window(&state, 300);
    let _ = app.emit("focus-search", ());
}

fn hide_main(app: &AppHandle, force: bool) -> bool {
    let Some(win) = main_window(app) else { return false };
    let state = app.state::<AppState>();

    // 管理弹层锁定：非强制路径只通知 renderer 保护草稿，不藏窗（基线 38/52）
    if !force
        && state.blur_hide_locked.load(Ordering::SeqCst)
        && !state.hidden_offscreen.load(Ordering::SeqCst)
    {
        if win.is_visible().unwrap_or(false) {
            let _ = win.set_focus();
        }
        let _ = app.emit("manage-layer-blocks-hide", ());
        return false;
    }
    if state.hidden_offscreen.load(Ordering::SeqCst) {
        return true;
    }

    // 仅真实显示过才保存几何，防止 offscreen 污染窗口状态
    if win.is_visible().unwrap_or(false) {
        if let (Ok(pos), Ok(size), Ok(outer)) =
            (win.outer_position(), win.inner_size(), win.outer_size())
        {
            let scale = win.scale_factor().unwrap_or(1.0);
            // store 存 Electron 语义的整窗尺寸（含标题栏）：inner + 标题栏高
            let titlebar_h = if outer.height > size.height {
                (outer.height - size.height) as f64 / scale
            } else {
                0.0
            };
            state.store.lock().unwrap().set_window_bounds(
                pos.x as f64 / scale,
                pos.y as f64 / scale,
                size.width as f64 / scale,
                size.height as f64 / scale + titlebar_h,
            );
        }
    }

    // 先解除置顶，避免隐藏后仍抢焦点
    let _ = win.set_always_on_top(false);
    let _ = win.set_visible_on_all_workspaces(false);

    // macOS：app.hide() 让焦点自然回到前一应用——粘贴链“自然前台”的前提（基线 30）
    #[cfg(target_os = "macos")]
    let _ = app.hide();

    // offscreen 待命：保持 webview 存活，下次唤起不重载
    let off_x = app
        .available_monitors()
        .map(|ms| {
            ms.iter()
                .map(|m| m.position().x + m.size().width as i32)
                .max()
                .unwrap_or(1920)
                + 2400
        })
        .unwrap_or(4400);
    let y = win.outer_position().map(|p| p.y).unwrap_or(0);
    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        off_x, y,
    )));

    state.hidden_offscreen.store(true, Ordering::SeqCst);
    true
}

fn toggle_main(app: &AppHandle) {
    let hidden = app.state::<AppState>().hidden_offscreen.load(Ordering::SeqCst);
    if hidden {
        show_main(app);
    } else {
        // 快捷键/托盘走 requestHide 语义：锁定时通知 renderer，不强藏
        hide_main(app, false);
    }
}

// —— Tauri 命令（bridge.js 映射面）——

#[tauri::command]
fn minimize_window(app: AppHandle) -> bool {
    // Electron minimize-window → hideMainWindow（强制路径）
    hide_main(&app, true)
}

#[tauri::command]
fn suppress_blur_hide(state: State<'_, AppState>, ms: u64) -> bool {
    set_blur_suppress_window(&state, ms);
    true
}

#[tauri::command]
fn set_blur_hide_locked(state: State<'_, AppState>, locked: bool) -> bool {
    state.blur_hide_locked.store(locked, Ordering::SeqCst);
    locked
}

#[tauri::command]
fn get_prompts(state: State<'_, AppState>) -> Value {
    state.store.lock().unwrap().get_prompts()
}

#[tauri::command]
fn set_prompts(state: State<'_, AppState>, prompts: Value) -> Result<Value, String> {
    if !prompts.is_array() {
        return Err("prompts must be an array".into());
    }
    Ok(state.store.lock().unwrap().set_prompts(prompts))
}

#[tauri::command]
fn get_hidden_tags(state: State<'_, AppState>) -> Value {
    state.store.lock().unwrap().get_hidden_tags()
}

#[tauri::command]
fn set_hidden_tags(state: State<'_, AppState>, tags: Value) -> Value {
    state.store.lock().unwrap().set_hidden_tags(tags)
}

#[tauri::command]
fn get_app_info() -> Value {
    json!({
        "name": "PromptBox",
        "version": "0.3.0-tauri-poc",
        "platform": std::env::consts::OS,
        "isPackaged": !cfg!(debug_assertions),
    })
}

#[tauri::command]
fn get_hotkey_info(app: AppHandle) -> Value {
    hotkey_info_value(&app)
}

#[tauri::command]
fn set_preferred_global_hotkey(app: AppHandle, state: State<'_, AppState>, accelerator: String) -> Result<Value, String> {
    // 允许偏好为内置候选，或当前已激活键（对齐 setPreferredGlobalHotkey 校验）
    let allowed: Vec<String> = HOTKEY_CANDIDATES.iter().map(|s| s.to_string()).collect();
    if !allowed.contains(&accelerator) {
        return Err("unsupported hotkey".into());
    }
    state
        .store
        .lock()
        .unwrap()
        .set_pref("preferredGlobalHotkey", json!(accelerator));
    setup_global_shortcut(&app);
    Ok(hotkey_info_value(&app))
}

#[tauri::command]
fn cycle_global_hotkey(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let active = app.state::<AppState>().active_hotkey.lock().unwrap().clone();
    let idx = HOTKEY_CANDIDATES.iter().position(|c| *c == active);
    let next = HOTKEY_CANDIDATES
        .iter()
        .cycle()
        .skip(idx.map(|i| i + 1).unwrap_or(0))
        .next()
        .copied()
        .unwrap_or("Alt+E");
    state
        .store
        .lock()
        .unwrap()
        .set_pref("preferredGlobalHotkey", json!(next));
    setup_global_shortcut(&app);
    Ok(hotkey_info_value(&app))
}

#[tauri::command]
fn pin_active_global_hotkey(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let active = app.state::<AppState>().active_hotkey.lock().unwrap().clone();
    if !active.is_empty() {
        state
            .store
            .lock()
            .unwrap()
            .set_pref("preferredGlobalHotkey", json!(active));
    }
    setup_global_shortcut(&app);
    Ok(hotkey_info_value(&app))
}

#[tauri::command]
fn write_clipboard(app: AppHandle, state: State<'_, AppState>, text: String) -> Result<bool, String> {
    if text.is_empty() {
        return Err("text required".into());
    }
    // 用户主动写入：取消待恢复，不回写（对齐 write-clipboard 注释语义）
    state.restore_generation.fetch_add(1, Ordering::SeqCst);
    *state.pending_restore.lock().unwrap() = None;
    app.clipboard()
        .write_text(text)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn copy_paste_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Result<Value, String> {
    if text.is_empty() {
        return Err("text required".into());
    }
    // 新一次调用：先按规则收尾上一次恢复，再占剪贴板
    flush_restore(&app, &state);
    let previous = app.clipboard().read_text().unwrap_or_default();
    app.clipboard()
        .write_text(text.clone())
        .map_err(|e| e.to_string())?;

    // 极短让出：真正的前台确认在粘贴链内自适应轮询
    hide_main(&app, true);
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;

    let mut session = state.session_paste_target.lock().unwrap().clone();
    let fallback = state.last_success_target.lock().unwrap().name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // session 整体移入，链路内对目标的纠正（pid 死亡、名字纠正）随闭包返回
        let outcome = paste::paste_clipboard_to_frontmost(&mut session.name, &mut session.pid, &fallback);
        (session, outcome)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (session, result) = result;
    *state.session_paste_target.lock().unwrap() = session;

    match result {
        Ok(outcome) => {
            if outcome.pasted {
                // 成功后收敛目标为 System Events 进程名，减少下次仅名称激活失败
                let mut name = outcome.front_name.clone();
                let pid = if outcome.pid > 0 {
                    outcome.pid
                } else {
                    state.last_success_target.lock().unwrap().pid
                };
                if pid > 0 {
                    let pname = paste::process_name_by_pid(pid);
                    if !pname.is_empty() && !paste::is_self_app_name(&pname) {
                        name = pname;
                    }
                }
                *state.last_success_target.lock().unwrap() = PasteTarget {
                    name: name.clone(),
                    pid,
                };
                state
                    .store
                    .lock()
                    .unwrap()
                    .set_pref("lastSuccessfulPasteTarget", json!(name));
                schedule_restore(app.clone(), previous, text);
            }
            Ok(json!({ "copied": true, "pasted": outcome.pasted }))
        }
        Err(classified) => {
            let accessibility = matches!(classified, paste::PasteError::Accessibility(_));
            let automation = matches!(classified, paste::PasteError::Automation(_));
            Ok(json!({
                "copied": true,
                "pasted": false,
                "requiresAccessibilityPermission": accessibility,
                "requiresAutomationPermission": automation,
                "automationTarget": if automation { Some("System Events") } else { None },
            }))
        }
    }
}

// —— 权限 / 系统设置 ——

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
}

// AXIsProcessTrustedWithOptions：prompt=true 时未授权会弹系统引导框
#[cfg(target_os = "macos")]
fn ax_is_trusted_with_prompt(prompt: bool) -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    unsafe {
        let key = CFString::new("AXTrustedCheckOptionPrompt");
        let value = if prompt {
            CFBoolean::true_value()
        } else {
            CFBoolean::false_value()
        };
        let dict = CFDictionary::from_CFType_pairs(&[(key, value)]);
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as *const std::ffi::c_void)
    }
}

fn exe_target_info() -> (String, String, bool) {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_default();
    // .app bundle 内 = 打包版；裸二进制（cargo run/build）= 开发模式
    let is_packaged = exe.contains(".app/Contents/MacOS/");
    (name, exe, is_packaged)
}

#[tauri::command]
fn get_permission_diagnostics() -> Value {
    #[cfg(target_os = "macos")]
    {
        let trusted = unsafe { AXIsProcessTrusted() };
        let (target_name, target_path, is_packaged) = exe_target_info();
        json!({
            "platform": "darwin",
            "accessibilityTrusted": trusted,
            // 身份键：冷却提示按可执行路径区分（重装/换路径后重新提示）
            "accessibilityIdentity": target_path,
            "targetName": target_name,
            "targetPath": target_path,
            "isPackaged": is_packaged,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        json!({ "platform": "other", "accessibilityTrusted": true, "isPackaged": true })
    }
}

// 唤起时主动请求：未授权则弹系统引导框（打开辅助功能设置的标准弹窗）
#[tauri::command]
fn request_accessibility_prompt(app: AppHandle) -> bool {
    // 系统弹框会抢焦点，抑制失焦隐藏防止窗口被误藏
    set_blur_suppress_window(&app.state::<AppState>(), 15000);
    #[cfg(target_os = "macos")]
    {
        ax_is_trusted_with_prompt(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

// 自动化权限探测：跑一次轻量 System Events 查询。
// 已授权 → granted；用户拒绝过 → denied（-1743，无弹窗）；
// 未决定 → 系统弹授权框，用户允许后 granted、拒绝后 denied；超时 → granted=false, denied=false
#[tauri::command]
async fn probe_automation_permission() -> Value {
    let result = tauri::async_runtime::spawn_blocking(|| {
        paste::run_command(
            "osascript",
            &["-e", "tell application \"System Events\" to return name of first application process"],
            2500,
        )
    })
    .await
    .unwrap_or_else(|_| Err("probe task failed".to_string()));
    match result {
        Ok(_) => json!({ "granted": true, "denied": false }),
        Err(e) => {
            let denied = e.contains("not authorized") || e.contains("(-1743)");
            json!({ "granted": false, "denied": denied })
        }
    }
}

fn open_privacy_pane(app: &AppHandle, pane: &str) -> bool {
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
    set_blur_suppress_window(&app.state::<AppState>(), 12000);
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .is_ok()
}

#[tauri::command]
fn open_accessibility_settings(app: AppHandle) -> bool {
    open_privacy_pane(&app, "Privacy_Accessibility")
}

#[tauri::command]
fn open_automation_settings(app: AppHandle) -> bool {
    open_privacy_pane(&app, "Privacy_Automation")
}

// —— 安全快照 / 导入导出 / 登录自启（阶段 3 完整实现）——

#[tauri::command]
fn list_safety_snapshots(state: State<'_, AppState>) -> Value {
    state.store.lock().unwrap().list_safety_snapshots()
}

#[tauri::command]
async fn restore_latest_safety_snapshot(app: AppHandle) -> Result<Value, String> {
    set_blur_suppress_window(&app.state::<AppState>(), 12000);
    let latest = app
        .state::<AppState>()
        .store
        .lock()
        .unwrap()
        .get_safety_snapshots()
        .first()
        .cloned();
    let Some(latest) = latest else {
        return Ok(json!({ "canceled": true, "reason": "empty" }));
    };
    let at = latest
        .get("at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let count = latest.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
    // ISO → 人话时间：2026-08-23T12:34:56.789Z → 2026-08-23 12:34:56 UTC
    let when = if at.is_empty() {
        "未知时间".to_string()
    } else {
        let s = at.replace('T', " ");
        match s.rfind('.') {
            Some(pos) if s.ends_with('Z') => format!("{} UTC", &s[..pos]),
            _ => s,
        }
    };
    let choice = show_button_dialog(
        &app,
        "恢复安全快照",
        "用本地安全快照覆盖当前提示词？",
        &format!("快照时间：{when}\n快照条数：{count}\n\n恢复前会把当前数据再存一份快照，仍可继续回退。"),
        &["取消", "恢复这份快照"],
        "恢复这份快照",
        Some("取消"),
    )?;
    if choice != "恢复这份快照" {
        return Ok(json!({ "canceled": true }));
    }
    let state = app.state::<AppState>();
    let mut store = state.store.lock().unwrap();
    let current = store.prompts_raw();
    if current.as_array().is_some_and(|a| !a.is_empty()) {
        store.push_safety_snapshot(&current, true);
    }
    let restored =
        helpers::sanitize_prompt_list(&latest.get("prompts").cloned().unwrap_or(json!([])));
    let prompts_count = restored.len();
    store.write_prompts(&restored);
    Ok(json!({ "canceled": false, "promptsCount": prompts_count, "at": at }))
}

#[tauri::command]
async fn choose_export_format(app: AppHandle) -> Result<String, String> {
    set_blur_suppress_window(&app.state::<AppState>(), 12000);
    // AppleScript 按钮上限 3 个：内容按钮 + Esc 取消（Electron 为四按钮，语义一致）
    let choice = show_button_dialog(
        &app,
        "导出提示词",
        "选择导出格式",
        "JSON 适合完整备份；Markdown / CSV 方便分享与表格处理。\n按 Esc 取消。",
        &["Markdown", "CSV", "JSON"],
        "JSON",
        None,
    )?;
    Ok(match choice.as_str() {
        "JSON" => "json",
        "Markdown" => "markdown",
        "CSV" => "csv",
        _ => "cancel",
    }
    .to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFilter {
    name: String,
    #[serde(default)]
    extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportPayload {
    content: String,
    #[serde(default)]
    default_path: Option<String>,
    #[serde(default)]
    filters: Option<Vec<ExportFilter>>,
}

#[tauri::command]
async fn export_prompts(app: AppHandle, payload: Value) -> Result<Value, String> {
    set_blur_suppress_window(&app.state::<AppState>(), 12000);
    // Electron 兼容：字符串载荷视为纯内容
    let payload = if let Some(content) = payload.as_str() {
        ExportPayload {
            content: content.to_string(),
            default_path: None,
            filters: None,
        }
    } else {
        serde_json::from_value(payload).map_err(|_| "export payload required".to_string())?
    };
    if payload.content.is_empty() {
        return Err("export payload required".into());
    }
    let default_path = payload
        .default_path
        .clone()
        .unwrap_or_else(|| "prompts_backup.json".to_string());
    // "*" 通配过滤组 macOS 原生面板不支持，跳过
    let filters: Vec<(String, Vec<String>)> = payload
        .filters
        .unwrap_or_default()
        .into_iter()
        .filter(|f| !f.extensions.iter().any(|e| e == "*"))
        .map(|f| (f.name, f.extensions))
        .collect();

    let was_visible = dialog_begin(&app);
    let app2 = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app2
            .dialog()
            .file()
            .set_title("导出提示词")
            .set_file_name(&default_path);
        for (name, exts) in &filters {
            let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter(name, &refs);
        }
        builder.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    dialog_end(&app, was_visible);

    let Some(file_path) = picked else {
        return Ok(json!({ "canceled": true }));
    };
    let path = file_path
        .simplified()
        .into_path()
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, &payload.content).map_err(|e| e.to_string())?;
    Ok(json!({ "canceled": false, "filePath": path.to_string_lossy() }))
}

#[tauri::command]
async fn import_prompts(app: AppHandle) -> Result<Value, String> {
    set_blur_suppress_window(&app.state::<AppState>(), 12000);
    let was_visible = dialog_begin(&app);
    let app2 = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app2.dialog()
            .file()
            .set_title("导入提示词")
            .add_filter("Prompt 文件", &["json", "md", "markdown", "csv"])
            .add_filter("JSON", &["json"])
            .add_filter("Markdown", &["md", "markdown"])
            .add_filter("CSV", &["csv"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    dialog_end(&app, was_visible);

    let Some(file_path) = picked else {
        return Ok(json!({ "canceled": true }));
    };
    let path = file_path
        .simplified()
        .into_path()
        .map_err(|e| e.to_string())?;
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let format = helpers::detect_import_format_from_path(&path.to_string_lossy());
    Ok(json!({
        "canceled": false,
        "raw": raw,
        "filePath": path.to_string_lossy(),
        "format": format,
    }))
}

#[tauri::command]
async fn choose_import_mode(app: AppHandle, payload: Value) -> Result<String, String> {
    set_blur_suppress_window(&app.state::<AppState>(), 12000);
    let import_count = payload
        .get("importCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .max(0);
    let existing_count = payload
        .get("existingCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .max(0);
    let choice = show_button_dialog(
        &app,
        "导入提示词",
        &format!("检测到 {import_count} 条提示词"),
        &format!(
            "当前已有 {existing_count} 条。\n合并：保留现有，并追加新项（名称+内容相同会跳过）。\n替换：用导入内容覆盖全部现有提示词。"
        ),
        &["取消", "替换全部", "合并导入"],
        "合并导入",
        Some("取消"),
    )?;
    Ok(match choice.as_str() {
        "合并导入" => "merge",
        "替换全部" => "replace",
        _ => "cancel",
    }
    .to_string())
}

#[tauri::command]
fn get_open_at_login(app: AppHandle) -> Value {
    json!({ "openAtLogin": app.autolaunch().is_enabled().unwrap_or(false) })
}

#[tauri::command]
fn set_open_at_login(app: AppHandle, enabled: bool) -> Result<Value, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    let open_at_login = manager.is_enabled().unwrap_or(enabled);
    rebuild_tray_menu(&app);
    Ok(json!({ "openAtLogin": open_at_login }))
}

#[tauri::command]
fn show_notification(payload: Value) -> bool {
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("PromptBox");
    let body = payload
        .get("body")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("message").and_then(|v| v.as_str()))
        .unwrap_or("");
    let title = paste::escape_applescript(title);
    let body = paste::escape_applescript(body);
    let _ = std::process::Command::new("osascript")
        .args(["-e", &format!("display notification \"{body}\" with title \"{title}\"")])
        .spawn();
    true
}

#[tauri::command]
fn prepare_quit_done(state: State<'_, AppState>) -> bool {
    state.quit_confirmed.store(true, Ordering::SeqCst);
    true
}

// —— JS alert/confirm 的原生替代 ——
// wry 未实现 WKWebView 的 JS 对话框面板：confirm() 静默返回 false、alert() 无效果。
// renderer 的 safeAlert/safeConfirm 检测到桥接方法时改走这里（Electron 无此方法，走原生 alert/confirm）。

#[tauri::command]
async fn show_alert_dialog(app: AppHandle, message: String) -> Result<bool, String> {
    set_blur_suppress_window(&app.state::<AppState>(), 12000);
    // 单按钮：Esc/关窗同样视为已读，对齐 alert 语义
    let _ = show_button_dialog(&app, "PromptBox", &message, "", &["好"], "好", Some("好"))?;
    Ok(true)
}

#[tauri::command]
async fn show_confirm_dialog(app: AppHandle, message: String) -> Result<bool, String> {
    set_blur_suppress_window(&app.state::<AppState>(), 12000);
    let choice = show_button_dialog(
        &app,
        "PromptBox",
        &message,
        "",
        &["取消", "好"],
        "好",
        Some("取消"),
    )?;
    Ok(choice == "好")
}

// —— WebDAV（阶段 4：对齐 main.js 的 9 个 webdav-* handler）——

#[tauri::command]
fn get_webdav_config(state: State<'_, AppState>) -> Value {
    webdav::get_config(&state.store.lock().unwrap().webdav())
}

#[tauri::command]
fn set_webdav_config(state: State<'_, AppState>, config: Value) -> Result<bool, String> {
    if !config.is_object() {
        return Err("invalid config".into());
    }
    let fields = webdav::config_fields_to_store(&config);
    state.store.lock().unwrap().merge_webdav(fields);
    Ok(true)
}

#[tauri::command]
fn get_webdav_settings(state: State<'_, AppState>) -> Value {
    webdav::get_settings(&state.store.lock().unwrap().webdav())
}

#[tauri::command]
fn set_webdav_settings(state: State<'_, AppState>, settings: Value) -> Result<bool, String> {
    let fields = webdav::settings_fields_to_store(&settings)?;
    state.store.lock().unwrap().merge_webdav(fields);
    Ok(true)
}

#[tauri::command]
async fn test_webdav(state: State<'_, AppState>) -> Result<bool, String> {
    let config = {
        let store = state.store.lock().unwrap();
        webdav::ensure_config(&store.webdav())?
    };
    webdav::test(&config).await
}

#[tauri::command]
async fn backup_webdav(state: State<'_, AppState>) -> Result<Value, String> {
    let (config, prompts) = {
        let store = state.store.lock().unwrap();
        (
            webdav::ensure_config(&store.webdav())?,
            helpers::sanitize_prompt_list(&store.prompts_raw()),
        )
    };
    let (remote_path, file_name) = webdav::backup(&config, &prompts).await?;
    state
        .store
        .lock()
        .unwrap()
        .merge_webdav(json!({ "lastAutoBackupAt": paste::now_ms() as i64 }));
    Ok(json!({ "remotePath": remote_path, "fileName": file_name }))
}

// applyRestoredPrompts：云端恢复覆盖前强制落安全快照，再 sanitize 写入
async fn apply_restored_prompts(app: &AppHandle, raw_prompts: Value) -> usize {
    let state = app.state::<AppState>();
    let mut store = state.store.lock().unwrap();
    let current = store.prompts_raw();
    if current.as_array().is_some_and(|a| !a.is_empty()) {
        store.push_safety_snapshot(&current, true);
    }
    let restored = helpers::sanitize_prompt_list(&raw_prompts);
    let count = restored.len();
    store.write_prompts(&restored);
    count
}

#[tauri::command]
async fn restore_webdav_latest(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let config = {
        let store = state.store.lock().unwrap();
        webdav::ensure_config(&store.webdav())?
    };
    let (remote_path, raw) = webdav::restore_latest(&config).await?;
    let prompts_count = apply_restored_prompts(&app, raw).await;
    Ok(json!({ "remotePath": remote_path, "promptsCount": prompts_count }))
}

#[tauri::command]
async fn restore_webdav_path(
    app: AppHandle,
    state: State<'_, AppState>,
    remote_path: String,
) -> Result<Value, String> {
    let config = {
        let store = state.store.lock().unwrap();
        webdav::ensure_config(&store.webdav())?
    };
    if remote_path.is_empty() {
        return Err("remotePath required".into());
    }
    let (remote_path, raw) = webdav::restore_path(&config, &remote_path).await?;
    let prompts_count = apply_restored_prompts(&app, raw).await;
    Ok(json!({ "remotePath": remote_path, "promptsCount": prompts_count }))
}

#[tauri::command]
async fn list_webdav_backups(state: State<'_, AppState>) -> Result<Value, String> {
    let config = {
        let store = state.store.lock().unwrap();
        webdav::ensure_config(&store.webdav())?
    };
    Ok(Value::Array(webdav::list_backups(&config).await?))
}

// scheduleAutoBackup 的每小时 tick：启用 + 到间隔才备份，成功后广播 auto-backup
async fn auto_backup_tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (enabled, interval_ms, last) = {
        let store = state.store.lock().unwrap();
        let s = webdav::get_settings(&store.webdav());
        (
            s["autoBackupEnabled"].as_bool().unwrap_or(false),
            (s["intervalDays"].as_f64().unwrap_or(3.0) * 24.0 * 60.0 * 60.0 * 1000.0) as u128,
            s["lastAutoBackupAt"].as_f64().unwrap_or(0.0) as u128,
        )
    };
    if !enabled {
        return;
    }
    let now = paste::now_ms();
    if now.saturating_sub(last) < interval_ms {
        return;
    }
    let (config, prompts) = {
        let store = state.store.lock().unwrap();
        match webdav::ensure_config(&store.webdav()) {
            Ok(config) => (config, helpers::sanitize_prompt_list(&store.prompts_raw())),
            Err(err) => {
                eprintln!("[prompt-box] Auto backup failed: {err}");
                return;
            }
        }
    };
    match webdav::backup(&config, &prompts).await {
        Ok((_, file_name)) => {
            state
                .store
                .lock()
                .unwrap()
                .merge_webdav(json!({ "lastAutoBackupAt": paste::now_ms() as i64 }));
            let _ = app.emit("auto-backup", file_name);
        }
        Err(err) => eprintln!("[prompt-box] Auto backup failed: {err}"),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .setup(|app| {
            // 菜单栏常驻：不占 Dock
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let store = store::Store::load(app.handle());
            app.manage(AppState {
                suppress_blur_hide_until: AtomicU64::new(0),
                blur_hide_locked: AtomicBool::new(false),
                hidden_offscreen: AtomicBool::new(true),
                restore_generation: AtomicU64::new(0),
                pending_restore: Mutex::new(None),
                session_paste_target: Mutex::new(PasteTarget::default()),
                last_success_target: Mutex::new(PasteTarget::default()),
                active_hotkey: Mutex::new(String::new()),
                store: Mutex::new(store),
                quitting: AtomicBool::new(false),
                quit_confirmed: AtomicBool::new(false),
            });

            // 主窗口：代码创建以携带 initialization_script（先于页面脚本注入桥接层）
            let _win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("PromptBox")
            // Electron 的 860×600/720×520 为整窗尺寸（含标题栏），Tauri 按内容区近似减 28
            .inner_size(860.0, 572.0)
            .min_inner_size(720.0, 492.0)
            .visible(false)
            .skip_taskbar(true)
            .initialization_script(include_str!("bridge.js"))
            .build()?;

            // 启动即对齐系统外观（标题栏 + prefers-color-scheme）
            sync_system_theme(app.handle());

            // 托盘：左键切换显示；菜单（显示/隐藏/登录自启/退出）由 rebuild_tray_menu 动态构建
            let tray_icon =
                tauri::image::Image::from_bytes(include_bytes!("../../assets/trayTemplate.png"))?;
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "hide" => {
                        hide_main(app, false);
                    }
                    "login" => toggle_open_at_login(app),
                    "quit" => request_quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        // 点托盘先抑制 blur-hide，避免窗口先被隐藏再切换（对齐 Electron suppressBlurHide(800)）
                        set_blur_suppress_window(&app.state::<AppState>(), 800);
                        toggle_main(app);
                    }
                })
                .build(app)?;

            // 快捷键注册（含冲突回退）+ 托盘菜单/气泡提示
            let active = setup_global_shortcut(app.handle());
            eprintln!("[prompt-box] active hotkey: {active}");
            rebuild_tray_menu(app.handle());
            if let Some(tray) = app.tray_by_id("main-tray") {
                let _ = tray.set_tooltip(Some(format!("PromptBox · {active}")));
            }

            // 自动备份：每小时检查一次（对齐 scheduleAutoBackup 的 setInterval(…, 3600_000)）
            {
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut tick =
                        tokio::time::interval(std::time::Duration::from_secs(3600));
                    tick.tick().await; // interval 首个 tick 立即触发，吃掉一次对齐 setInterval
                    loop {
                        tick.tick().await;
                        auto_backup_tick(&app).await;
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(false) => {
                // 失焦自动隐藏（基线 10）：160ms 防抖，对齐 Electron scheduleHideOnBlur
                let app = window.app_handle().clone();
                let win_for_check = window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(160)).await;
                    let state = app.state::<AppState>();
                    if state.hidden_offscreen.load(Ordering::SeqCst)
                        || state.blur_hide_locked.load(Ordering::SeqCst)
                        || blur_hide_suppressed(&state)
                        || win_for_check.is_focused().unwrap_or(false)
                    {
                        return;
                    }
                    hide_main(&app, true);
                });
            }
            WindowEvent::CloseRequested { api, .. } => {
                // 点关闭 = 隐藏待命，不退出
                api.prevent_close();
                hide_main(window.app_handle(), false);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_prompts,
            set_prompts,
            get_hidden_tags,
            set_hidden_tags,
            get_app_info,
            get_permission_diagnostics,
            get_hotkey_info,
            set_preferred_global_hotkey,
            cycle_global_hotkey,
            pin_active_global_hotkey,
            minimize_window,
            suppress_blur_hide,
            set_blur_hide_locked,
            write_clipboard,
            copy_paste_prompt,
            open_accessibility_settings,
            open_automation_settings,
            list_safety_snapshots,
            restore_latest_safety_snapshot,
            choose_export_format,
            export_prompts,
            import_prompts,
            choose_import_mode,
            get_open_at_login,
            set_open_at_login,
            show_notification,
            prepare_quit_done,
            get_webdav_config,
            set_webdav_config,
            get_webdav_settings,
            set_webdav_settings,
            test_webdav,
            backup_webdav,
            restore_webdav_latest,
            restore_webdav_path,
            list_webdav_backups,
            show_alert_dialog,
            show_confirm_dialog,
            probe_automation_permission,
            request_accessibility_prompt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
