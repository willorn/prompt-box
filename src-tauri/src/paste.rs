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

// ApplicationServices FFI：辅助功能权限检查。
// CGEvent 在未授权时静默失败（不发按键也不报错），须显式前置检查才能给用户明确反馈。
#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[cfg(target_os = "macos")]
fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

#[cfg(not(target_os = "macos"))]
fn accessibility_trusted() -> bool {
    true
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

// —— 诊断日志 ——
// 时间戳取进程启动至今的相对毫秒，方便看每一步的实际耗时。
fn t_ms() -> u128 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis()
}

// GUI 应用由 LaunchServices 拉起，`open --stderr` 的重定向实测**不生效**
// （文件恒为 0 字节），stderr 会直接丢掉。所以这里自带一份落盘日志：
// 每次进程启动把文件截断重写，文件内容始终是「本次运行」。
// 可用环境变量 PROMPTBOX_LOG 覆盖路径（测试/临时排查用）。
fn log_file_path() -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("PROMPTBOX_LOG") {
        return Some(std::path::PathBuf::from(p));
    }
    let home = std::env::var_os("HOME")?;
    let mut p = std::path::PathBuf::from(home);
    p.push("Library/Application Support/com.promptmaster.desktop.tauri/paste.log");
    Some(p)
}

pub fn log(msg: impl AsRef<str>) {
    // 绝对时间 + 进程内相对毫秒：前者看"什么时候"，后者看"顺序与耗时"
    let line = format!(
        "[{} +{:>6}ms] {}",
        chrono::Local::now().format("%m-%d %H:%M:%S%.3f"),
        t_ms(),
        msg.as_ref()
    );
    eprintln!("{line}");

    let Some(path) = log_file_path() else { return };
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        // 表头记的是**首次写日志**的时间（不是进程启动时间——本 app 在首次唤起前不写日志）
        let _ = std::fs::write(
            &path,
            format!(
                "=== PromptBox pid={} 首次记录于 {} ===\n",
                std::process::id(),
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            ),
        );
    });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

#[derive(Clone, Default, Debug)]
pub struct FrontmostInfo {
    pub name: String,
    pub pid: i64,
}

// —— 错误分类：Accessibility / Automation / Unknown ——
#[derive(Debug)]
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

// 自动化权限（Apple Events → System Events）探测：跑一次轻量 System Events 查询。
// 已授权 → false；权限被拒/违例 → true。按错误码 + 关键词识别（中英系统都覆盖）。
fn automation_permission_denied() -> bool {
    let result = run_osascript(
        &[
            "tell application \"System Events\"",
            "return name of first application process",
            "end tell",
        ],
        1200,
    );
    match result {
        Ok(_) => {
            log("自动化权限探测：System Events 可访问");
            false
        }
        Err(e) => {
            log(format!("自动化权限探测失败：{e}"));
            let e = e.to_lowercase();
            e.contains("not authorized")
                || e.contains("not permitted")
                || e.contains("permission")
                || e.contains("权限")
                || e.contains("-1743")
                || e.contains("-10004")
        }
    }
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
    // 实测 `lsappinfo info -only pid,name <asn>` 输出形如：
    //   "pid"=604
    //   "LSDisplayName"="Google Chrome"
    // 键名**自带一对引号**，也可能不带（LSDisplayName="X"），= 两侧还可能有空格。
    // 旧实现只认 `KEY="` 这一种形态，把最常见、也是本机真实的 `"KEY"=` 全漏掉了
    // → 恒返回空串，只能靠 process_name_by_pid 的 ps basename 兜底；而 Electron 应用
    // 的 basename 是通用的 "Electron"（WorkBuddy = /Applications/WorkBuddy.app/Contents/MacOS/Electron），
    // 于是目标应用被认成别的（见 is_self_app_name 注释）。
    for key in ["LSDisplayName", "name"] {
        let mut from = 0usize;
        while let Some(rel) = raw[from..].find(key) {
            let idx = from + rel;
            from = idx + key.len();
            let rest = &raw[idx + key.len()..];
            // 吃掉键的闭合引号与空白："KEY"  →  =
            let rest = rest.trim_start();
            let rest = rest.strip_prefix('"').unwrap_or(rest);
            let rest = rest.trim_start();
            let Some(rest) = rest.strip_prefix('=') else {
                continue;
            };
            let rest = rest.trim_start();
            // 值可能带引号（"X"）也可能裸写（X）
            let name = match rest.strip_prefix('"') {
                Some(quoted) => match quoted.find('"') {
                    Some(end) => quoted[..end].trim().to_string(),
                    None => String::new(),
                },
                None => rest
                    .split(['\n', '\r'])
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"')
                    .to_string(),
            };
            if !name.is_empty() {
                return name;
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
    // ps 不可用（受限环境）时的兜底：System Events 查进程名。
    // 旧实现把结果 map 成 `let _` 丢掉了、无条件返回空串，等于兜底完全不生效。
    if let Ok(out) = run_osascript(
        &[
            "tell application \"System Events\"",
            &format!("name of first process whose unix id is {pid}"),
            "end tell",
        ],
        800,
    ) {
        let name = out.trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    String::new()
}

pub fn is_self_app_name(name: &str) -> bool {
    // dev 二进制名 prompt-box；打包后 PromptBox。
    // ⚠️ 绝不能再把 "electron" 列进来：一批 Electron 应用的主可执行文件就叫 `Electron`
    // （WorkBuddy 即 `/Applications/WorkBuddy.app/Contents/MacOS/Electron`），
    // 名字判自己会把这些应用当成本进程排除掉 → 粘贴链判定「没有外部前台应用」、
    // 连 Cmd+V 都不发，表现为「某些应用里粘不进去」。
    // 真正的自身识别交给 pid（is_self_pid / is_self_target）。
    matches!(
        name.trim().to_lowercase().as_str(),
        "promptbox" | "prompt-box" | "prompt-box-tauri"
    )
}

/// 自身识别的主口径：pid 与本进程相同。
/// 名字是启发式、会误伤；pid 不会。
pub fn is_self_pid(pid: i64) -> bool {
    pid > 0 && pid == std::process::id() as i64
}

/// 统一判定「这个前台目标是不是 PromptBox 自己」：pid 命中或名字命中即算。
pub fn is_self_target(name: &str, pid: i64) -> bool {
    is_self_pid(pid) || (!name.trim().is_empty() && is_self_app_name(name))
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
        if live_name.is_empty() || is_self_target(&live_name, *session_pid) {
            log(format!(
                "  路径0 放弃：pid {} 活着但名字={:?}（空或自己）",
                session_pid, live_name
            ));
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
                log(format!("  路径0 激活成功：pid {}", session_pid));
                delay(80);
                return true;
            }
            log(format!(
                "  路径0 激活失败：pid {} → {}",
                session_pid,
                result.err().unwrap_or_default().trim()
            ));
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
        log("  无可用目标名，直接放弃");
        delay(160);
        return false;
    }
    // 目标名就是自己（唤起时前台记到了 PromptBox）：别把"激活自己"当成功。
    // 否则后续复查前台仍是自己 → pasted=false，还白白多跑两次 osascript。
    if is_self_app_name(&target) {
        log(format!("  目标名 {target:?} 是 PromptBox 自己，放弃激活"));
        delay(160);
        return false;
    }
    let safe = escape_applescript(&target);
    log(format!(
        "  按名字激活 target={target:?}（session_name={:?} fallback={fallback_name:?}）",
        session_name
    ));

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
        log("  路径1 激活成功（System Events 进程名）");
        delay(100);
        return true;
    }
    log(format!(
        "  路径1 失败：{}",
        by_name.err().unwrap_or_default().trim()
    ));

    // 路径 2：tell application activate（进程名与应用名不一致时更稳）
    let by_app = run_osascript(&[&format!("tell application \"{safe}\" to activate")], 1000);
    if by_app.is_ok() {
        log("  路径2 激活成功（tell application activate）");
        delay(120);
        return true;
    }
    log(format!(
        "  路径2 失败：{}",
        by_app.err().unwrap_or_default().trim()
    ));
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
            log("  投递 Cmd+V（kCGHIDEventTap）");
            CGEventPost(TAP_SESSION, down);
            thread::sleep(Duration::from_millis(5));
            CGEventPost(TAP_SESSION, up);
            core_foundation::base::CFRelease(down.cast());
            core_foundation::base::CFRelease(up.cast());
            log("  Cmd+V 已投递");
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
        if !last.name.is_empty() && !is_self_target(&last.name, last.pid) {
            return last;
        }
        delay(step);
    }
    if !last.name.is_empty() && !is_self_target(&last.name, last.pid) {
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
    // 辅助功能权限前置检查：CGEvent 未授权时静默失败（不发按键不报错），
    // 这里显式拦截，让上层明确提示「缺辅助功能权限」而非误导性的「已拷贝到剪贴板」。
    let trusted = accessibility_trusted();
    log(format!(
        "=== 粘贴链开始 session=({:?}, pid {}) fallback={:?} a11y={}",
        session_name, session_pid, fallback_name, trusted
    ));
    if !trusted {
        return Err(PasteError::Accessibility(
            "辅助功能权限未授权（AXIsProcessTrusted=false）".into(),
        ));
    }

    // 优先信任 hide 后的自然前台；焦点仍在自己身上时才强制激活记忆目标。
    fn resolve_external(
        session_name: &mut String,
        session_pid: &mut i64,
        fallback_name: &str,
    ) -> Result<FrontmostInfo, PasteError> {
        let info = wait_natural_external_frontmost(220, 35);
        log(format!("  resolve#1 自然前台 = {:?}/{}", info.name, info.pid));
        if !info.name.is_empty() {
            return Ok(info);
        }
        let act = activate_paste_target(session_name, session_pid, fallback_name);
        log(format!(
            "  resolve#2 强制激活={act} → session=({:?}, {})",
            session_name, session_pid
        ));
        let info = wait_natural_external_frontmost(160, 40);
        log(format!("  resolve#3 自然前台 = {:?}/{}", info.name, info.pid));
        if !info.name.is_empty() {
            return Ok(info);
        }
        activate_paste_target(session_name, session_pid, fallback_name);
        delay(80);
        let info = frontmost_fast();
        log(format!("  resolve#4 最终前台 = {:?}/{}", info.name, info.pid));
        if !info.name.is_empty() && !is_self_target(&info.name, info.pid) {
            return Ok(info);
        }
        Err(PasteError::Unknown("no external frontmost".into()))
    }

    let front = match resolve_external(session_name, session_pid, fallback_name) {
        Ok(f) => f,
        Err(e) => {
            log("  前台解析失败，开始探测自动化权限");
            // 解析外部前台失败：若自动化权限（System Events）被拒，给出明确分类，
            // 让上层提示「缺自动化权限」而非笼统的「已拷贝到剪贴板」。
            if automation_permission_denied() {
                return Err(PasteError::Automation(
                    "自动化权限未授权（System Events）".into(),
                ));
            }
            return Err(e);
        }
    };
    log(format!("  锁定目标 = {:?}/{}", front.name, front.pid));
    send_paste_keystroke()?;
    // 键击成功后复核：只有仍停在自己身上才判定失败；读不到前台名时信任键击前确认的外部应用。
    delay(40);
    let after = frontmost_fast();
    let self_front = !after.name.is_empty() && is_self_target(&after.name, after.pid);
    log(format!(
        "  键击后前台 = {:?}/{} → pasted={}",
        after.name, after.pid, !self_front
    ));
    if self_front {
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

#[cfg(test)]
mod tests {
    use super::*;

    // 真实输出：`lsappinfo info -only pid,name <asn>`，键名自带一对引号。
    // 旧实现漏吃键的闭合引号 → 恒返回空串，只能靠 ps basename 兜底，
    // 而 Electron 应用的 basename 是通用的 "Electron"（WorkBuddy 即如此），
    // 于是目标应用被认成别的。这条用例锁住回归。
    #[test]
    fn parses_lsappinfo_quoted_display_name() {
        let raw = "\"pid\"=604\n\"LSDisplayName\"=\"Google Chrome\"\n";
        assert_eq!(parse_lsappinfo_display_name(raw), "Google Chrome");
    }

    #[test]
    fn parses_lsappinfo_workbuddy_electron_binary() {
        // WorkBuddy：可执行文件叫 Electron，但 LSDisplayName 是 WorkBuddy。
        let raw = "\"pid\"=83535\n\"LSDisplayName\"=\"WorkBuddy\"\n";
        assert_eq!(parse_lsappinfo_display_name(raw), "WorkBuddy");
    }

    #[test]
    fn parses_lsappinfo_legacy_unquoted_key() {
        assert_eq!(
            parse_lsappinfo_display_name("pid=1\nLSDisplayName=\"WeChat\"\n"),
            "WeChat"
        );
        assert_eq!(parse_lsappinfo_display_name("name=\"Notes\"\n"), "Notes");
    }

    #[test]
    fn parses_lsappinfo_spaced_and_bare_value() {
        assert_eq!(parse_lsappinfo_display_name("LSDisplayName = \"Trae\""), "Trae");
        assert_eq!(parse_lsappinfo_display_name("LSDisplayName=Qoder\n"), "Qoder");
    }

    #[test]
    fn parses_lsappinfo_missing_name_returns_empty() {
        assert_eq!(parse_lsappinfo_display_name("\"pid\"=604\n"), "");
    }

    #[test]
    fn parses_lsappinfo_pid() {
        assert_eq!(parse_lsappinfo_pid("\"pid\"=604\n\"LSDisplayName\"=\"X\"\n"), 604);
    }

    // 关键回归：一批 Electron 应用的主可执行文件就叫 `Electron`，
    // 名字判自己会把它排除掉 → 粘贴链判定「没有外部前台应用」、Cmd+V 都不发。
    #[test]
    fn electron_binary_name_is_not_self() {
        assert!(!is_self_app_name("Electron"));
        assert!(!is_self_app_name("electron"));
        assert!(!is_self_app_name("WorkBuddy"));
        assert!(!is_self_target("Electron", 83535));
    }

    #[test]
    fn promptbox_names_are_self() {
        assert!(is_self_app_name("PromptBox"));
        assert!(is_self_app_name("prompt-box"));
        assert!(is_self_app_name("prompt-box-tauri"));
    }

    #[test]
    fn own_pid_is_self_even_with_other_name() {
        let me = std::process::id() as i64;
        assert!(is_self_pid(me));
        assert!(is_self_target("Anything", me));
        assert!(!is_self_pid(0));
        assert!(!is_self_pid(-1));
        assert!(!is_self_pid(me + 1));
    }

    // 日志必须真正落盘：GUI 应用 `open --stderr` 无效，只有文件这一条可靠通道。
    #[test]
    fn log_lands_in_file() {
        let dir = std::env::temp_dir().join("promptbox-log-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("paste.log");
        let _ = std::fs::remove_file(&path);
        std::env::set_var("PROMPTBOX_LOG", &path);

        log("hello-from-test");

        let content = std::fs::read_to_string(&path).unwrap_or_default();
        std::env::remove_var("PROMPTBOX_LOG");
        let _ = std::fs::remove_file(&path);

        assert!(content.contains("hello-from-test"), "content = {content:?}");
    }
}
