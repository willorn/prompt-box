// 粘贴链移植：lsappinfo 前台识别 → 三级激活回退 → osascript keystroke → 错误分类。
// 忠实对照 main.js 基线 31/48/51/54：pid 优先、名称回退、application activate 兜底。

use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use wait_timeout::ChildExt;

// CoreGraphics FFI：CGEvent 直接发按键（绕过 osascript 子进程权限限制）
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateKeyboardEvent(
        source: *const std::ffi::c_void,
        virtualKey: u16,
        keyDown: bool,
    ) -> *mut std::ffi::c_void;
    fn CGEventPost(tap: u32, event: *mut std::ffi::c_void);
    fn CGEventSetFlags(event: *mut std::ffi::c_void, flags: u64);
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn delay(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}

#[derive(Clone, Default, Debug)]
pub struct FrontmostInfo {
    pub name: String,
    pub pid: i64,
}

// —— 错误分类：Accessibility / Automation 变体保留，供未来 CGEvent 错误码映射 ——
#[derive(Debug)]
#[allow(dead_code)]
pub enum PasteError {
    /// 粘贴键击被系统拒绝：辅助功能权限（对应 Electron accessibility 分类）
    Accessibility(String),
    /// Apple Events 权限（对应 automation 分类）
    Automation(String),
    /// 其他失败
    Unknown(String),
}

// —— 带超时的子进程（对齐 runExecFile / runOsascript 的超时保护）——
pub(crate) fn run_command(program: &str, args: &[&str], timeout_ms: u64) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    match child.wait_timeout(Duration::from_millis(timeout_ms.max(200))) {
        Ok(Some(status)) => {
            let mut stdout = String::new();
            let mut stderr = String::new();
            if let Some(mut s) = child.stdout.take() {
                let _ = s.read_to_string(&mut stdout);
            }
            if let Some(mut s) = child.stderr.take() {
                let _ = s.read_to_string(&mut stderr);
            }
            if status.success() {
                Ok(stdout)
            } else {
                Err(stderr.trim().to_string())
            }
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("{program} timeout"))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn run_osascript(lines: &[&str], timeout_ms: u64) -> Result<String, String> {
    // 与 runOsascript 一致：多行脚本逐行 -e
    let mut args: Vec<&str> = Vec::new();
    for line in lines {
        args.push("-e");
        args.push(line);
    }
    run_command("osascript", &args, timeout_ms.max(200))
}

pub fn escape_applescript(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

// —— lsappinfo：唤起热路径，两次调用拿 pid + 显示名 ——
fn parse_lsappinfo_pid(raw: &str) -> i64 {
    // 对齐 parseLsappinfoPid：/pid"?\s*=\s*(\d+)/i
    let mut text = raw;
    let pid = loop {
        let Some(idx) = text.find("pid") else { break 0 };
        let rest = &text[idx + 3..];
        let rest = rest.strip_prefix('"').unwrap_or(rest);
        let rest = rest.trim_start();
        let rest = rest.strip_prefix('=').unwrap_or(rest);
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            text = &text[idx + 3..];
            continue;
        }
        break digits.parse().unwrap_or(0);
    };
    pid
}

fn parse_lsappinfo_display_name(raw: &str) -> String {
    // Electron 匹配 LSDisplayName；实际输出可能只有 "name"=，两者都认。
    for key in ["LSDisplayName", "name"] {
        let marker = format!("{key}\"");
        if let Some(idx) = raw.find(&marker).or_else(|| raw.find(key)) {
            let rest = &raw[idx + key.len()..];
            let rest = rest.trim_start();
            let Some(rest) = rest.strip_prefix('=') else { continue };
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('"') {
                if let Some(end) = rest.find('"') {
                    let name = rest[..end].trim().to_string();
                    if !name.is_empty() {
                        return name;
                    }
                }
            }
        }
    }
    String::new()
}

pub fn frontmost_fast() -> FrontmostInfo {
    // getFrontmostAppInfoFast：两次 lsappinfo，失败不拖热路径。
    let Ok(asn) = run_command("lsappinfo", &["front"], 280) else {
        return FrontmostInfo::default();
    };
    let asn = asn.trim();
    if asn.is_empty() {
        return FrontmostInfo::default();
    }
    let Ok(info_raw) = run_command("lsappinfo", &["info", "-only", "pid,name", asn], 280) else {
        return FrontmostInfo::default();
    };
    let pid = parse_lsappinfo_pid(&info_raw);
    let mut name = parse_lsappinfo_display_name(&info_raw);
    if pid > 0 && name.is_empty() {
        name = process_name_by_pid(pid);
    }
    if name.is_empty() && pid == 0 {
        return FrontmostInfo::default();
    }
    FrontmostInfo { name, pid }
}

pub fn process_name_by_pid(pid: i64) -> String {
    // 优先 ps（毫秒级，basename 即 System Events 进程名），失败回退 System Events 查询。
    if pid <= 0 {
        return String::new();
    }
    let pid_str = pid.to_string();
    if let Ok(comm) = run_command("ps", &["-p", &pid_str, "-o", "comm="], 400) {
        let base = comm.trim();
        let base = base.rsplit('/').next().unwrap_or(base);
        if !base.is_empty() {
            return base.to_string();
        }
    }
    let _ = run_osascript(
        &[
            "tell application \"System Events\"",
            &format!("name of first process whose unix id is {pid}"),
            "end tell",
        ],
        800,
    )
    .map(|s| s.trim().to_string());
    String::new()
}

pub fn is_self_app_name(name: &str) -> bool {
    // dev 二进制名 prompt-box；打包后 PromptBox；Electron 版并存时也排除。
    matches!(
        name.trim().to_lowercase().as_str(),
        "promptbox" | "prompt-box" | "prompt-box-tauri" | "electron"
    )
}

fn process_names_match(a: &str, b: &str) -> bool {
    // LSDisplayName 与 ps comm 常不一致（微信/WeChat）：压缩空白后小写比较。
    let norm = |s: &str| s.to_lowercase().split_whitespace().collect::<String>();
    norm(a) == norm(b) && !norm(a).is_empty()
}

// —— 三级激活回退（activatePasteTargetApp 全量移植）——
// 返回是否激活成功；副作用：校正/清空传入的会话目标（pid 死亡、名字纠正）。
pub fn activate_paste_target(session_name: &mut String, session_pid: &mut i64, fallback_name: &str) -> bool {
    // 路径 0：按唤起时记录的 pid 激活。只拒绝“进程已死 / 变成自己”。
    if *session_pid > 0 {
        let live_name = process_name_by_pid(*session_pid);
        if live_name.is_empty() || is_self_app_name(&live_name) {
            *session_pid = 0;
        } else {
            let expected = session_name.trim();
            if !expected.is_empty() && !process_names_match(&live_name, expected) {
                // 纠正为 System Events 可识别的进程名，供路径 1 回退。
                *session_name = live_name;
            }
            let result = run_osascript(
                &[
                    "tell application \"System Events\"",
                    &format!(
                        "set frontmost of first process whose unix id is {} to true",
                        session_pid
                    ),
                    "end tell",
                ],
                1000,
            );
            if result.is_ok() {
                delay(80);
                return true;
            }
            *session_pid = 0;
        }
    }

    let target = session_name.trim().to_string();
    let target = if !target.is_empty() {
        target
    } else {
        fallback_name.trim().to_string()
    };
    if target.is_empty() {
        delay(160);
        return false;
    }
    let safe = escape_applescript(&target);

    // 路径 1：System Events 进程名
    let by_name = run_osascript(
        &[
            "tell application \"System Events\"",
            &format!("if not (exists process \"{safe}\") then error \"process missing\""),
            &format!("set frontmost of first process whose name is \"{safe}\" to true"),
            "end tell",
        ],
        1000,
    );
    if by_name.is_ok() {
        delay(100);
        return true;
    }

    // 路径 2：tell application activate（进程名与应用名不一致时更稳）
    let by_app = run_osascript(&[&format!("tell application \"{safe}\" to activate")], 1000);
    if by_app.is_ok() {
        delay(120);
        return true;
    }
    delay(140);
    false
}

fn send_paste_keystroke() -> Result<(), PasteError> {
    #[cfg(target_os = "macos")]
    {
        const K_V: u16 = 0x09; // kVK_ANSI_V
        const K_CMD: u64 = 0x00100000; // kCGEventFlagMaskCommand
        const TAP_SESSION: u32 = 0; // kCGHIDEventTap
        unsafe {
            let down = CGEventCreateKeyboardEvent(std::ptr::null(), K_V, true);
            let up = CGEventCreateKeyboardEvent(std::ptr::null(), K_V, false);
            if down.is_null() || up.is_null() {
                if !down.is_null() { core_foundation::base::CFRelease(down.cast()); }
                if !up.is_null() { core_foundation::base::CFRelease(up.cast()); }
                return Err(PasteError::Unknown("CGEventCreateKeyboardEvent returned null".into()));
            }
            CGEventSetFlags(down, K_CMD);
            CGEventSetFlags(up, K_CMD);
            CGEventPost(TAP_SESSION, down);
            thread::sleep(Duration::from_millis(5));
            CGEventPost(TAP_SESSION, up);
            core_foundation::base::CFRelease(down.cast());
            core_foundation::base::CFRelease(up.cast());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

fn wait_natural_external_frontmost(max_ms: u64, step_ms: u64) -> FrontmostInfo {
    // hide 后轮询自然前台：比固定 sleep 更贴合真实让出时机。
    let budget = max_ms.max(40);
    let step = step_ms.max(20);
    let started = now_ms();
    let mut last = FrontmostInfo::default();
    while now_ms() - started < budget as u128 {
        last = frontmost_fast();
        if !last.name.is_empty() && !is_self_app_name(&last.name) {
            return last;
        }
        delay(step);
    }
    if !last.name.is_empty() && !is_self_app_name(&last.name) {
        return last;
    }
    FrontmostInfo::default()
}

#[derive(Debug)]
pub struct PasteOutcome {
    pub pasted: bool,
    pub front_name: String,
    pub pid: i64,
}

// 完整粘贴链核心：解析外部前台 → 键击 → 复核。
// 调用前必须已 hide 窗口（自然让出前台是链路的前提）。
pub fn paste_clipboard_to_frontmost(
    session_name: &mut String,
    session_pid: &mut i64,
    fallback_name: &str,
) -> Result<PasteOutcome, PasteError> {
    // 优先信任 hide 后的自然前台；焦点仍在自己身上时才强制激活记忆目标。
    fn resolve_external(
        session_name: &mut String,
        session_pid: &mut i64,
        fallback_name: &str,
    ) -> Result<FrontmostInfo, PasteError> {
        let info = wait_natural_external_frontmost(220, 35);
        if !info.name.is_empty() {
            return Ok(info);
        }
        activate_paste_target(session_name, session_pid, fallback_name);
        let info = wait_natural_external_frontmost(160, 40);
        if !info.name.is_empty() {
            return Ok(info);
        }
        activate_paste_target(session_name, session_pid, fallback_name);
        delay(80);
        let info = frontmost_fast();
        if !info.name.is_empty() && !is_self_app_name(&info.name) {
            return Ok(info);
        }
        Err(PasteError::Unknown("no external frontmost".into()))
    }

    let front = resolve_external(session_name, session_pid, fallback_name)?;
    send_paste_keystroke()?;
    // 键击成功后复核：只有仍停在自己身上才判定失败；读不到前台名时信任键击前确认的外部应用。
    delay(40);
    let after = frontmost_fast();
    if !after.name.is_empty() && is_self_app_name(&after.name) {
        return Ok(PasteOutcome {
            pasted: false,
            front_name: front.name,
            pid: front.pid,
        });
    }
    Ok(PasteOutcome {
        pasted: true,
        front_name: front.name,
        pid: front.pid,
    })
}
