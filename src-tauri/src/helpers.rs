// prompt-helpers.js 全量移植（538 行 → Rust）。
// 忠实对照语义：sanitize / merge 去重 / markdown·csv 解析 / 搜索分词评分 / 高亮 / 导出格式化。
// 已知差异（均为可接受近似）：
// - to_timestamp 无时区按 UTC 解析（JS Date.parse 按本地时区）；自家数据恒带 Z，不受影响。
// - compare_prompts_for_use 的名称排序用码点序（JS localeCompare zh-CN 需 ICU）。
// - 大小写折叠按 char 1:1 假设（中文/ASCII 场景成立）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub name: String,
    pub tag: String,
    pub content: String,
    pub is_pinned: bool,
    pub use_count: i64,
    pub last_used_at: String,
}

// JS \s 空白集 = Unicode White_Space + \v \f \ufeff（Rust is_whitespace 不含后三者）
fn is_js_whitespace(c: char) -> bool {
    matches!(c, '\u{b}' | '\u{c}' | '\u{feff}') || c.is_whitespace()
}

fn js_to_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => "[object Object]".into(),
    }
}

// Math.max(0, Number(prompt.useCount || 0))：0/非数值 falsy → 0
fn js_use_count(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(0.0);
            if !f.is_finite() || f == 0.0 {
                0
            } else {
                f.max(0.0) as i64
            }
        }
        Some(Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .map(|f| if !f.is_finite() || f == 0.0 { 0 } else { f.max(0.0) as i64 })
            .unwrap_or(0),
        _ => 0,
    }
}

// —— normalize / sanitize ——

pub fn normalize_prompt(prompt: &Value) -> Option<Prompt> {
    if !prompt.is_object() {
        return None;
    }
    let name = js_to_string(prompt.get("name"))
        .trim_matches(is_js_whitespace)
        .to_string();
    let content = js_to_string(prompt.get("content"))
        .trim_matches(is_js_whitespace)
        .to_string();
    if name.is_empty() || content.is_empty() {
        return None;
    }
    Some(Prompt {
        name,
        tag: match prompt.get("tag") {
            Some(Value::String(s)) => s.trim_matches(is_js_whitespace).to_string(),
            _ => String::new(),
        },
        content,
        is_pinned: prompt.get("isPinned").and_then(|v| v.as_bool()) == Some(true),
        use_count: js_use_count(prompt.get("useCount")),
        last_used_at: match prompt.get("lastUsedAt") {
            Some(Value::String(s)) => s.trim_matches(is_js_whitespace).to_string(),
            _ => String::new(),
        },
    })
}

pub fn sanitize_prompt_list(list: &Value) -> Vec<Prompt> {
    list.as_array()
        .map(|arr| arr.iter().filter_map(normalize_prompt).collect())
        .unwrap_or_default()
}

// —— 合并去重 ——

pub fn prompt_identity_key(prompt: &Prompt) -> String {
    format!(
        "{}\n{}",
        prompt.name.trim().to_lowercase(),
        prompt.content.trim().to_lowercase()
    )
}

pub struct MergeResult {
    pub prompts: Vec<Prompt>,
    pub added: usize,
    pub skipped: usize,
}

pub fn merge_prompt_lists(existing: &Value, incoming: &Value) -> MergeResult {
    let base = sanitize_prompt_list(existing);
    let next = sanitize_prompt_list(incoming);
    merge_sanitized(base, &next)
}

pub fn merge_sanitized(mut base: Vec<Prompt>, next: &[Prompt]) -> MergeResult {
    let mut seen: HashSet<String> = base.iter().map(prompt_identity_key).collect();
    let mut added = 0usize;
    let mut skipped = 0usize;
    for item in next {
        let key = prompt_identity_key(item);
        if seen.contains(&key) {
            skipped += 1;
            continue;
        }
        seen.insert(key);
        base.push(item.clone());
        added += 1;
    }
    MergeResult {
        prompts: base,
        added,
        skipped,
    }
}

// —— Markdown 导入 ——

// ^#{1,3}\s+(.+)$
fn parse_markdown_heading(line: &str) -> Option<String> {
    let hashes = line.chars().take_while(|&c| c == '#').count();
    if hashes == 0 || hashes > 3 {
        return None;
    }
    let after = line.get(hashes..)?;
    let ws_len: usize = after
        .chars()
        .take_while(|c| is_js_whitespace(*c))
        .map(|c| c.len_utf8())
        .sum();
    if ws_len == 0 {
        return None; // \s+ 至少一个空白
    }
    let title = &after[ws_len..];
    if title.is_empty() {
        return None; // (.+) 至少一个字符
    }
    Some(title.trim_matches(is_js_whitespace).to_string())
}

// ^(标签|tag)\s*[:：]\s*(.+)$ （tag 不区分大小写）
fn parse_tag_line(line: &str) -> Option<String> {
    let consumed = if line.starts_with("标签") {
        "标签".len()
    } else if line.len() >= 3 && line.as_bytes()[..3].eq_ignore_ascii_case(b"tag") {
        3
    } else {
        return None;
    };
    let rest = &line[consumed..];
    let rest = rest.trim_start_matches(is_js_whitespace);
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('：'))?;
    let rest = rest.trim_start_matches(is_js_whitespace);
    if rest.is_empty() {
        return None;
    }
    Some(rest.trim_matches(is_js_whitespace).to_string())
}

fn markdown_fence(line: &str) -> Option<(char, usize, &str)> {
    let trimmed = line.trim_start();
    if line.len() - trimmed.len() > 3 { return None; }
    let marker = trimmed.chars().next()?;
    if marker != '~' && marker != char::from(96) { return None; }
    let length = trimmed.chars().take_while(|c| *c == marker).count();
    if length < 3 { return None; }
    Some((marker, length, trimmed[length..].trim()))
}

pub fn parse_markdown_prompts(raw: &str) -> Vec<Prompt> {
    let source = raw
        .strip_prefix('\u{feff}')
        .unwrap_or(raw)
        .trim_matches(is_js_whitespace);
    if source.is_empty() {
        return vec![];
    }

    // split(/\r?\n/)
    let lines: Vec<&str> = source
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();

    struct Block {
        name: String,
        tag: String,
        content: String,
    }

    let mut blocks: Vec<Block> = Vec::new();
    let mut current: Option<Block> = None;
    let mut fence: Option<(char, usize, bool)> = None;

    let flush = |blocks: &mut Vec<Block>, b: Block| {
        let name = b.name.trim().to_string();
        let content = b.content.trim().to_string();
        if !name.is_empty() && !content.is_empty() {
            blocks.push(Block { name, tag: b.tag, content });
        }
    };

    for line in &lines {
        let marker = markdown_fence(line);
        if let Some((ch, length, wrapper)) = fence {
            let closes = marker.is_some_and(|(c, n, info)| c == ch && n >= length && info.is_empty());
            if closes { fence = None; }
            if !closes || !wrapper {
                if let Some(b) = current.as_mut() {
                    if !b.content.is_empty() { b.content.push(char::from(10)); }
                    b.content.push_str(line);
                }
            }
            continue;
        }
        if let Some((ch, length, info)) = marker {
            let wrapper = info == "promptbox-content"
                && current.as_ref().is_some_and(|b| b.content.trim().is_empty());
            fence = Some((ch, length, wrapper));
            if !wrapper {
                if let Some(b) = current.as_mut() {
                    if !b.content.is_empty() { b.content.push(char::from(10)); }
                    b.content.push_str(line);
                }
            }
            continue;
        }
        if let Some(title) = parse_markdown_heading(line) {
            if let Some(b) = current.take() {
                flush(&mut blocks, b);
            }
            current = Some(Block {
                name: title,
                tag: String::new(),
                content: String::new(),
            });
            continue;
        }
        let Some(b) = current.as_mut() else { continue };

        // 标签行仅在内容区为空时识别
        if b.content.trim_matches(is_js_whitespace).is_empty() {
            if let Some(tag) = parse_tag_line(line) {
                b.tag = tag;
                continue;
            }
        }
        if b.content.is_empty() {
            b.content = line.to_string();
        } else {
            b.content.push('\n');
            b.content.push_str(line);
        }
    }
    if let Some(b) = current.take() {
        flush(&mut blocks, b);
    }

    // 无标题 → 整文件作为一个 prompt
    if blocks.is_empty() {
        let first_line = lines
            .iter()
            .find(|l| !l.trim_matches(is_js_whitespace).is_empty())
            .copied()
            .unwrap_or("导入提示词");
        let name: String = first_line
            .trim_start_matches('#')
            .trim_matches(is_js_whitespace)
            .chars()
            .take(40)
            .collect();
        let name = if name.is_empty() {
            "导入提示词".to_string()
        } else {
            name
        };
        blocks.push(Block {
            name,
            tag: "imported".into(),
            content: source.to_string(),
        });
    }

    blocks
        .into_iter()
        .map(|b| Prompt {
            name: b.name,
            tag: b.tag,
            content: b.content,
            is_pinned: false,
            use_count: 0,
            last_used_at: String::new(),
        })
        .collect()
}

// —— CSV 导入 ——

pub fn parse_csv_rows(raw: &str) -> Vec<Vec<String>> {
    let source = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let chars: Vec<char> = source.chars().collect();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;

    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied();

        if in_quotes {
            if ch == '"' && next == Some('"') {
                field.push('"');
                i += 2;
                continue;
            }
            if ch == '"' {
                in_quotes = false;
                i += 1;
                continue;
            }
            field.push(ch);
            i += 1;
            continue;
        }

        match ch {
            '"' => in_quotes = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\n' => {
                row.push(std::mem::take(&mut field));
                if row.iter().any(|c| !c.trim_matches(is_js_whitespace).is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            '\r' => {}
            _ => field.push(ch),
        }
        i += 1;
    }
    row.push(field);
    if row
        .iter()
        .any(|c| !c.trim_matches(is_js_whitespace).is_empty())
    {
        rows.push(row);
    }
    rows
}

pub fn parse_csv_prompts(raw: &str) -> Vec<Prompt> {
    let rows = parse_csv_rows(raw);
    if rows.is_empty() {
        return vec![];
    }

    // trim + toLowerCase + 去全部空白
    let normalize_header = |v: &str| -> String {
        v.trim_matches(is_js_whitespace)
            .to_lowercase()
            .split(|c: char| is_js_whitespace(c))
            .collect()
    };

    let header: Vec<String> = rows[0].iter().map(|c| normalize_header(c)).collect();
    const HEADER_CANDIDATES: &[&str] = &[
        "name", "title", "content", "prompt", "tag", "tags", "category", "名称", "标题", "内容",
        "提示词", "标签", "分类",
    ];
    let looks_like_header = header
        .iter()
        .any(|c| HEADER_CANDIDATES.contains(&c.as_str()));

    let mut data_rows = &rows[..];
    let mut name_idx: i64 = 0;
    let mut tag_idx: i64 = 1;
    let mut content_idx: i64 = 2;

    if looks_like_header {
        data_rows = &rows[1..];
        let find_idx = |cands: &[&str]| -> i64 {
            header
                .iter()
                .position(|c| cands.contains(&c.as_str()))
                .map(|i| i as i64)
                .unwrap_or(-1)
        };
        name_idx = find_idx(&["name", "title", "名称", "标题"]);
        content_idx = find_idx(&["content", "prompt", "body", "内容", "提示词"]);
        tag_idx = find_idx(&["tag", "tags", "category", "标签", "分类"]);
        if name_idx < 0 {
            name_idx = 0;
        }
        if content_idx < 0 {
            content_idx = (header.len() as i64 - 1).max(1);
        }
    }

    let prompts: Vec<Prompt> = data_rows
        .iter()
        .map(|row| {
            let cell = |idx: i64| -> String {
                if idx >= 0 {
                    row.get(idx as usize)
                        .cloned()
                        .unwrap_or_default()
                        .trim_matches(is_js_whitespace)
                        .to_string()
                } else {
                    String::new()
                }
            };
            let name = cell(name_idx);
            let content = cell(content_idx);
            let tag = if tag_idx >= 0 { cell(tag_idx) } else { String::new() };
            let name = if !name.is_empty() {
                name
            } else if !content.is_empty() {
                content.chars().take(40).collect()
            } else {
                "导入提示词".to_string()
            };
            Prompt {
                name,
                tag,
                content,
                is_pinned: false,
                use_count: 0,
                last_used_at: String::new(),
            }
        })
        .collect();

    // sanitize：过滤 content 为空的行
    prompts
        .into_iter()
        .filter(|p| !p.content.trim_matches(is_js_whitespace).is_empty())
        .collect()
}

pub fn extract_prompts_from_import(raw: &str, format: &str) -> Result<Vec<Prompt>, String> {
    match format {
        "markdown" => Ok(parse_markdown_prompts(raw)),
        "csv" => Ok(parse_csv_prompts(raw)),
        _ => {
            let parsed: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
            let prompts = match parsed {
                Value::Array(a) => Value::Array(a),
                Value::Object(ref o) if o.get("prompts").map(|p| p.is_array()).unwrap_or(false) => {
                    o.get("prompts").cloned().unwrap()
                }
                _ => {
                    return Err(
                        "文件格式错误：必须是提示词数组，或包含 prompts 数组的备份文件".into(),
                    )
                }
            };
            Ok(sanitize_prompt_list(&prompts))
        }
    }
}

// —— HTML / 高亮 ——

pub fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn tokenize_search_term(term: &str) -> Vec<String> {
    term.to_lowercase()
        .split(|c: char| is_js_whitespace(c))
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

pub fn prompt_search_haystack(item: &Prompt) -> String {
    format!(
        "{}\n{}\n{}",
        item.name.to_lowercase(),
        item.tag.trim().to_lowercase(),
        item.content.to_lowercase()
    )
}

pub fn prompt_matches_search(item: &Prompt, term: &str) -> bool {
    let raw = term.to_lowercase().trim_matches(is_js_whitespace).to_string();
    if raw.is_empty() {
        return true;
    }
    let haystack = prompt_search_haystack(item);
    if haystack.contains(&raw) {
        return true;
    }
    let tokens = tokenize_search_term(&raw);
    if tokens.is_empty() {
        return true;
    }
    tokens.iter().all(|t| haystack.contains(t.as_str()))
}

pub fn highlight_match(text: &str, term: &str) -> String {
    let source = text;

    // Set 去重保序 + 长度降序稳定排序
    let tokens = tokenize_search_term(term);
    let mut uniq: Vec<String> = Vec::new();
    for t in tokens {
        if !uniq.contains(&t) {
            uniq.push(t);
        }
    }
    uniq.sort_by_key(|t| std::cmp::Reverse(t.chars().count()));
    if uniq.is_empty() {
        return escape_html(source);
    }

    let lower = source.to_lowercase();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for token in &uniq {
        if token.is_empty() {
            continue;
        }
        let mut from = 0usize;
        while from < lower.len() {
            let Some(rel) = lower[from..].find(token.as_str()) else {
                break;
            };
            let idx = from + rel;
            ranges.push((idx, idx + token.len()));
            from = idx + token.len();
        }
    }
    if ranges.is_empty() {
        return escape_html(source);
    }

    // 起点升序、终点降序；相接（start == last.end）也合并
    ranges.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.0 <= last.1 => last.1 = last.1.max(range.1),
            _ => merged.push(range),
        }
    }

    let mut out = String::new();
    let mut cursor = 0usize;
    for (start, end) in merged {
        if let (Some(before), Some(hit)) = (source.get(cursor..start), source.get(start..end)) {
            out.push_str(&escape_html(before));
            out.push_str("<mark class=\"search-mark\">");
            out.push_str(&escape_html(hit));
            out.push_str("</mark>");
            cursor = end;
        }
    }
    out.push_str(&escape_html(source.get(cursor..).unwrap_or("")));
    out
}

// —— 时间 ——

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// Howard Hinnant civil_from_days：天数 → (年, 月, 日)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn now_iso8601() -> String {
    let ms = now_ms() as i64;
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        mo,
        d,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60,
        millis
    )
}

// Date.parse 子集：YYYY-MM-DD(THH:MM(:SS)?(.fff)?(Z|±HH[:]MM)?)；无时区按 UTC
fn parse_iso8601_to_ms(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    if bytes[4] != b'-' {
        return None;
    }
    let month: i64 = s.get(5..7)?.parse().ok()?;
    if bytes[7] != b'-' {
        return None;
    }
    let day: i64 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut total_ms = days_from_civil(year, month, day) * 86_400_000;
    let rest = s.get(10..)?;
    if !rest.is_empty() {
        let rest = rest.strip_prefix(['T', 't', ' '])?;
        if rest.len() < 5 {
            return None;
        }
        let rb = rest.as_bytes();
        let hh: i64 = rest.get(0..2)?.parse().ok()?;
        if rb[2] != b':' {
            return None;
        }
        let mm: i64 = rest.get(3..5)?.parse().ok()?;
        if hh > 23 || mm > 59 {
            return None;
        }
        total_ms += (hh * 3600 + mm * 60) * 1000;
        let mut rest = &rest[5..];

        if let Some(stripped) = rest.strip_prefix(':') {
            if stripped.len() < 2 {
                return None;
            }
            let ss: i64 = stripped.get(0..2)?.parse().ok()?;
            if ss > 59 {
                return None;
            }
            total_ms += ss * 1000;
            rest = &stripped[2..];
        }
        if let Some(stripped) = rest.strip_prefix('.') {
            let digits: String = stripped
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if digits.is_empty() {
                return None;
            }
            let mut ms_str = digits.clone();
            ms_str.truncate(3);
            while ms_str.len() < 3 {
                ms_str.push('0');
            }
            total_ms += ms_str.parse::<i64>().ok()?;
            rest = &stripped[digits.len()..];
        }
        if !rest.is_empty() {
            match rest.as_bytes()[0] {
                b'Z' | b'z' => {}
                b'+' | b'-' => {
                    let sign: i64 = if rest.starts_with('-') { -1 } else { 1 };
                    let tz = &rest[1..];
                    let (th, tm) = if let Some(stripped) = tz.strip_prefix(':') {
                        if stripped.len() < 4 {
                            return None;
                        }
                        (
                            stripped.get(0..2)?.parse::<i64>().ok()?,
                            stripped.get(2..4)?.parse::<i64>().ok()?,
                        )
                    } else if tz.len() == 4 {
                        (
                            tz.get(0..2)?.parse::<i64>().ok()?,
                            tz.get(2..4)?.parse::<i64>().ok()?,
                        )
                    } else if tz.len() == 2 {
                        (tz.parse::<i64>().ok()?, 0)
                    } else {
                        return None;
                    };
                    if th > 23 || tm > 59 {
                        return None;
                    }
                    total_ms -= sign * (th * 3600 + tm * 60) * 1000;
                }
                _ => return None,
            }
        }
    }
    Some(total_ms)
}

pub fn to_timestamp(value: &str) -> i64 {
    parse_iso8601_to_ms(value.trim()).unwrap_or(0)
}

pub fn format_relative_time(value: &str) -> String {
    let timestamp = to_timestamp(value);
    if timestamp == 0 {
        return "最近未使用".into();
    }
    let diff = now_ms() as i64 - timestamp;
    if diff < 60_000 {
        return "刚刚使用".into();
    }
    if diff < 3_600_000 {
        return format!("{} 分钟前", diff / 60_000);
    }
    if diff < 86_400_000 {
        return format!("{} 小时前", diff / 3_600_000);
    }
    if diff < 30 * 86_400_000 {
        return format!("{} 天前", diff / 86_400_000);
    }
    // toLocaleDateString("zh-CN")："2026/1/1"
    let (y, m, d) = civil_from_days(timestamp.div_euclid(86_400_000));
    format!("{y}/{m}/{d}")
}

// —— 排序 / 评分 ——

pub fn compare_prompts_for_use(a: &Prompt, b: &Prompt) -> std::cmp::Ordering {
    let da = to_timestamp(&a.last_used_at);
    let db = to_timestamp(&b.last_used_at);
    if da != db {
        return db.cmp(&da);
    }
    let ua = a.use_count.max(0);
    let ub = b.use_count.max(0);
    if ua != ub {
        return ub.cmp(&ua);
    }
    // JS localeCompare("zh-CN")：码点序近似（不影响基线测试）
    a.name.cmp(&b.name)
}

pub fn score_token_against_prompt(item: &Prompt, token: &str) -> i64 {
    if token.is_empty() {
        return 0;
    }
    let name = item.name.to_lowercase();
    let tag = item.tag.trim().to_lowercase();
    let content = item.content.to_lowercase();
    let mut score = 0i64;

    if name == token {
        score += 1000;
    } else if name.starts_with(token) {
        score += 520;
    } else if name.contains(token) {
        score += 320;
    }

    if tag == token {
        score += 220;
    } else if tag.starts_with(token) {
        score += 140;
    } else if tag.contains(token) {
        score += 90;
    }

    if let Some(pos) = content.find(token) {
        score += 45;
        let char_idx = content[..pos].chars().count();
        if char_idx < 48 {
            score += 25;
        }
    }
    score
}

pub fn score_prompt_match(item: &Prompt, term: &str) -> i64 {
    if term.is_empty() {
        return 0;
    }
    let raw = term.to_lowercase().trim_matches(is_js_whitespace).to_string();
    if raw.is_empty() || !prompt_matches_search(item, &raw) {
        return 0;
    }

    let tokens = tokenize_search_term(&raw);
    let mut score = score_token_against_prompt(item, &raw);

    if tokens.len() > 1 {
        for token in &tokens {
            score += score_token_against_prompt(item, token);
        }
        let name = item.name.to_lowercase();
        if tokens.iter().all(|t| name.contains(t.as_str())) {
            score += 180;
        }
    }

    if item.is_pinned {
        score += 18;
    }
    score += (item.use_count.max(0) * 2).min(40);
    let ts = to_timestamp(&item.last_used_at);
    if ts > 0 {
        let days = (now_ms() as i64 - ts) / 86_400_000;
        if days < 1 {
            score += 24;
        } else if days < 7 {
            score += 14;
        } else if days < 30 {
            score += 6;
        }
    }
    score
}

pub fn compare_prompts_for_search(a: &Prompt, b: &Prompt, term: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let sa = score_prompt_match(a, term);
    let sb = score_prompt_match(b, term);
    if sa != sb {
        return sb.cmp(&sa);
    }
    if a.is_pinned != b.is_pinned {
        return if a.is_pinned {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    compare_prompts_for_use(a, b)
}

pub fn mark_prompt_used(prompt: &mut Prompt) {
    prompt.use_count = prompt.use_count.max(0) + 1;
    prompt.last_used_at = now_iso8601();
}

// —— 导出 / 分享格式 ——

pub fn format_prompt_as_markdown(prompt: &Prompt) -> String {
    let mut lines = vec![format!("# {}", prompt.name)];
    if !prompt.tag.is_empty() {
        lines.push(format!("标签: {}", prompt.tag));
    }
    lines.push(String::new());
    let mut longest = 0;
    let mut run = 0;
    for ch in prompt.content.chars() {
        run = if ch == '~' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let fence = "~".repeat(3.max(longest + 1));
    lines.push(format!("{fence}promptbox-content"));
    lines.push(prompt.content.clone());
    lines.push(fence);
    lines.push(String::new());
    lines.join("\n")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareJson {
    name: String,
    tag: String,
    content: String,
    is_pinned: bool,
}

pub fn format_prompt_as_json(prompt: &Prompt) -> String {
    serde_json::to_string_pretty(&ShareJson {
        name: prompt.name.clone(),
        tag: prompt.tag.clone(),
        content: prompt.content.clone(),
        is_pinned: prompt.is_pinned,
    })
    .unwrap_or_default()
}

pub fn format_prompt_share_text(prompt: &Prompt, format: &str) -> String {
    if format == "json" {
        format_prompt_as_json(prompt)
    } else {
        format_prompt_as_markdown(prompt)
    }
}

pub fn escape_csv_cell(value: &str) -> String {
    if value.contains('"') || value.contains(',') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

pub fn format_prompts_as_markdown(list: &[Prompt]) -> String {
    if list.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = list
        .iter()
        .map(|i| {
            format_prompt_as_markdown(i)
                .trim_end_matches(is_js_whitespace)
                .to_string()
        })
        .collect();
    let joined = parts.join("\n\n");
    format!("{}\n", joined.trim_matches(is_js_whitespace))
}

pub fn format_prompts_as_csv(list: &[Prompt]) -> String {
    let header = "name,tag,content";
    let rows: Vec<String> = list
        .iter()
        .map(|i| {
            [
                escape_csv_cell(&i.name),
                escape_csv_cell(&i.tag),
                escape_csv_cell(&i.content),
            ]
            .join(",")
        })
        .collect();
    let mut out = vec![header.to_string()];
    out.extend(rows.iter().cloned());
    let mut s = out.join("\n");
    if !rows.is_empty() {
        s.push('\n');
    }
    s
}

pub fn format_prompts_as_json(list: &[Prompt]) -> String {
    serde_json::to_string_pretty(list).unwrap_or_else(|_| "[]".into())
}

pub fn detect_import_format_from_path(file_path: &str) -> &'static str {
    let lower = file_path.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "md" | "markdown" => "markdown",
        "csv" => "csv",
        _ => "json",
    }
}

// —— 首启种子（基线 20/33）——

pub fn get_default_sample_prompts() -> Vec<Prompt> {
    vec![
        Prompt {
            name: "文章润色专家".into(),
            tag: "writing".into(),
            content: "请将下面的文本润色为更通顺、更专业的中文，同时保留原意并给出三种不同风格（正式、亲切、技术性）的改写版本。".into(),
            is_pinned: true,
            use_count: 0,
            last_used_at: String::new(),
        },
        Prompt {
            name: "Tailwind 助手".into(),
            tag: "coding".into(),
            content: "根据下面的 UI 描述，生成对应的 Tailwind CSS 类名与简短示例 HTML，包含响应式样式和可访问性建议。".into(),
            is_pinned: false,
            use_count: 0,
            last_used_at: String::new(),
        },
        Prompt {
            name: "市场文案生成器".into(),
            tag: "marketing".into(),
            content: "为一款目标用户为职场人士的时间管理工具，生成三条不同角度的产品宣传文案（简洁、情感、功能导向），并包含一句 30 字以内的广告语。".into(),
            is_pinned: false,
            use_count: 0,
            last_used_at: String::new(),
        },
    ]
}

// —— 使用摘要 ——

pub struct UsageSummary {
    pub use_text: String,
    pub last_used_text: String,
}

pub fn get_usage_summary(item: &Prompt) -> UsageSummary {
    let count = item.use_count.max(0);
    UsageSummary {
        use_text: if count > 0 {
            format!("已使用 {count} 次")
        } else {
            "尚未使用".into()
        },
        last_used_text: format_relative_time(&item.last_used_at),
    }
}

// ===== 测试：逐条对照 tests/prompt-helpers.test.mjs =====

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn markdown_body_roundtrip() {
        let body = ["tag: body", "# Heading", "## Details", "~~~markdown", "# Code", "~~~", "~~~~promptbox-content", "Nested", "~~~~"].join(&char::from(10).to_string());
        let items = vec![prompt("A", "coding", &body, 0, ""), prompt("B", "", "# Body", 0, "")];
        assert_eq!(parse_markdown_prompts(&format_prompts_as_markdown(&items)), items);
    }

    fn prompt(name: &str, tag: &str, content: &str, use_count: i64, last_used_at: &str) -> Prompt {
        Prompt {
            name: name.into(),
            tag: tag.into(),
            content: content.into(),
            is_pinned: false,
            use_count,
            last_used_at: last_used_at.into(),
        }
    }

    #[test]
    fn csv_with_quotes() {
        let csv = "name,tag,content\n文章润色专家,writing,\"请润色,并保留原意\"\nTailwind 助手,coding,生成类名\n";
        let prompts = parse_csv_prompts(csv);
        assert_eq!(prompts.len(), 2);
        assert_eq!(prompts[0].content, "请润色,并保留原意");
    }

    #[test]
    fn markdown_headings() {
        let md = "# 文章润色专家\n标签: writing\n请润色下面的文本\n\n## Tailwind 助手\ntag: coding\n生成 tailwind 类名\n";
        let md_prompts = parse_markdown_prompts(md);
        assert_eq!(md_prompts.len(), 2);
        assert_eq!(md_prompts[0].tag, "writing");

        // Merge dedupe
        let existing = json!([{ "name": "文章润色专家", "content": "请润色下面的文本", "tag": "writing" }]);
        let incoming = serde_json::to_value(&md_prompts).unwrap();
        let merged = merge_prompt_lists(&existing, &incoming);
        assert_eq!(merged.added, 1);
        assert_eq!(merged.skipped, 1);
        assert_eq!(merged.prompts.len(), 2);
    }

    #[test]
    fn highlight_basic() {
        let hl = highlight_match("文章润色专家", "润色");
        assert!(hl.contains("<mark class=\"search-mark\">润色</mark>"));
    }

    #[test]
    fn search_score_exact_name_first() {
        let items = vec![
            prompt("润色", "writing", "简短", 0, ""),
            prompt("文章润色专家", "writing", "润色文本", 5, ""),
            prompt("市场文案", "marketing", "写文案", 1, ""),
        ];
        let mut ranked = items.clone();
        ranked.sort_by(|a, b| compare_prompts_for_search(a, b, "润色"));
        assert_eq!(ranked[0].name, "润色");
        assert!(score_prompt_match(&ranked[0], "润色") > score_prompt_match(&ranked[1], "润色"));
    }

    #[test]
    fn json_extract() {
        let raw = serde_json::to_string(&json!({ "prompts": [{ "name": "X", "content": "Y", "tag": "t" }] })).unwrap();
        let json_prompts = extract_prompts_from_import(&raw, "json").unwrap();
        assert_eq!(json_prompts.len(), 1);
        assert_eq!(json_prompts[0].name, "X");
    }

    #[test]
    fn share_formats() {
        let item = normalize_prompt(&json!({
            "name": "文章润色专家", "tag": "writing", "content": "请润色下面的文本"
        }))
        .unwrap();
        let shared_md = format_prompt_as_markdown(&item);
        assert!(shared_md.starts_with("# 文章润色专家"));
        assert!(shared_md.contains("标签: writing"));
        assert!(shared_md.contains("请润色下面的文本"));

        let x = prompt("X", "t", "Y", 0, "");
        let shared_json = format_prompt_share_text(&x, "json");
        assert!(shared_json.contains("\"name\": \"X\""));
        assert!(shared_json.contains("\"content\": \"Y\""));
    }

    #[test]
    fn empty_and_invalid_inputs() {
        assert_eq!(parse_csv_prompts("").len(), 0);
        assert_eq!(parse_markdown_prompts("").len(), 0);
        assert!(extract_prompts_from_import("{bad", "json").is_err());
    }

    #[test]
    fn csv_without_header() {
        let no_header = parse_csv_prompts("润色助手,writing,请润色文本\n代码助手,coding,写函数\n");
        assert_eq!(no_header.len(), 2);
        assert_eq!(no_header[0].name, "润色助手");
        assert_eq!(no_header[0].tag, "writing");
    }

    #[test]
    fn exact_title_ranks_above_partial_content() {
        let mut ranked = vec![
            prompt("其他", "", "包含润色二字", 99, ""),
            prompt("润色", "", "短", 0, ""),
        ];
        ranked.sort_by(|a, b| compare_prompts_for_search(a, b, "润色"));
        assert_eq!(ranked[0].name, "润色");
    }

    #[test]
    fn highlight_escapes_html() {
        let dangerous = highlight_match("<b>润色</b>", "润色");
        assert!(dangerous.contains("&lt;b&gt;"));
        assert!(dangerous.contains("<mark class=\"search-mark\">润色</mark>"));
    }

    #[test]
    fn merge_keeps_existing_metadata() {
        let merged = merge_prompt_lists(
            &json!([{ "name": "A", "content": "1", "tag": "t", "useCount": 3, "lastUsedAt": "2026-01-01T00:00:00.000Z" }]),
            &json!([{ "name": "A", "content": "1", "tag": "t" }, { "name": "B", "content": "2", "tag": "t" }]),
        );
        assert_eq!(merged.added, 1);
        assert_eq!(merged.skipped, 1);
        assert_eq!(merged.prompts[0].use_count, 3);
    }

    #[test]
    fn bulk_export_formats() {
        let bulk = json!([
            { "name": "A", "tag": "t", "content": "hello, world" },
            { "name": "B", "tag": "", "content": "line1\nline2" },
        ]);
        let list = sanitize_prompt_list(&bulk);

        let md_bulk = format_prompts_as_markdown(&list);
        assert!(md_bulk.contains("# A"));
        assert!(md_bulk.contains("# B"));

        let csv_bulk = format_prompts_as_csv(&list);
        assert!(csv_bulk.starts_with("name,tag,content"));
        assert!(csv_bulk.contains("\"hello, world\""));

        let json_bulk = format_prompts_as_json(&list);
        let parsed: Value = serde_json::from_str(&json_bulk).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 2);

        assert_eq!(detect_import_format_from_path("a.MD"), "markdown");
        assert_eq!(detect_import_format_from_path("b.csv"), "csv");
        assert_eq!(detect_import_format_from_path("c.json"), "json");
    }

    #[test]
    fn multi_token_search() {
        assert_eq!(
            tokenize_search_term("  文章  润色 "),
            vec!["文章".to_string(), "润色".to_string()]
        );
        assert_eq!(
            tokenize_search_term("文章\u{3000}润色"),
            vec!["文章".to_string(), "润色".to_string()]
        );

        let item = prompt("文章润色专家", "writing", "请润色下面的文本", 0, "");
        assert!(prompt_matches_search(&item, "文章 润色"));
        assert!(!prompt_matches_search(&item, "文章 coding"));

        let mut multi_ranked = vec![
            prompt("市场文案", "marketing", "写宣传", 9, ""),
            prompt("文章润色专家", "writing", "请润色文本", 1, ""),
        ];
        multi_ranked.sort_by(|a, b| compare_prompts_for_search(a, b, "文章 润色"));
        assert_eq!(multi_ranked[0].name, "文章润色专家");

        let multi_hl = highlight_match("文章润色专家", "文章 润色");
        // 相邻命中会合并成一段 mark，这是预期行为。
        assert!(multi_hl.contains("<mark class=\"search-mark\">文章润色</mark>")
            || (multi_hl.contains("<mark class=\"search-mark\">文章</mark>")
                && multi_hl.contains("<mark class=\"search-mark\">润色</mark>")));

        let spread = highlight_match("文章与润色助手", "文章 润色");
        assert!(spread.contains("<mark class=\"search-mark\">文章</mark>"));
        assert!(spread.contains("<mark class=\"search-mark\">润色</mark>"));
    }

    #[test]
    fn default_sample_seeds() {
        let samples = get_default_sample_prompts();
        assert!(!samples.is_empty());
        for item in &samples {
            assert!(!item.name.is_empty() && !item.content.is_empty());
        }
    }

    // —— 时间工具补充（JS 测试未覆盖，但属移植完整性验证）——

    #[test]
    fn iso8601_roundtrip_and_parse() {
        let iso = now_iso8601();
        assert!(iso.ends_with('Z'));
        assert_eq!(iso.len(), 24); // YYYY-MM-DDTHH:MM:SS.sssZ
        let ts = to_timestamp(&iso);
        assert!(ts > 0);

        assert_eq!(to_timestamp("2026-01-01T00:00:00.000Z"), 1_767_225_600_000);
        assert_eq!(to_timestamp("not a date"), 0);
        assert_eq!(to_timestamp(""), 0);
    }

    #[test]
    fn relative_time_buckets() {
        // 最近未使用
        let item = prompt("x", "", "y", 0, "");
        let s = get_usage_summary(&item);
        assert_eq!(s.use_text, "尚未使用");
        assert_eq!(s.last_used_text, "最近未使用");

        // 刚刚使用 / 已使用 N 次
        let now_iso = now_iso8601();
        let used = prompt("x", "", "y", 3, &now_iso);
        let s = get_usage_summary(&used);
        assert_eq!(s.use_text, "已使用 3 次");
        assert_eq!(s.last_used_text, "刚刚使用");

        // 时间戳解析正确性（to_timestamp > 0 分支）
        let old = prompt("x", "", "y", 1, "2020-01-01T00:00:00.000Z");
        let s = get_usage_summary(&old);
        assert!(s.last_used_text.contains("天前") || s.last_used_text.contains('/'));
    }

    #[test]
    fn mark_used_increments() {
        let mut item = prompt("x", "", "y", 5, "");
        mark_prompt_used(&mut item);
        assert_eq!(item.use_count, 6);
        assert!(item.last_used_at.ends_with('Z'));
    }

    #[test]
    fn markdown_fallback_whole_file() {
        let prompts = parse_markdown_prompts("没有标题的普通文本\n第二行");
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].name, "没有标题的普通文本");
        assert_eq!(prompts[0].tag, "imported");
        assert!(prompts[0].content.contains("第二行"));
    }

    #[test]
    fn csv_header_in_chinese() {
        let csv = "名称,标签,内容\n润色助手,writing,请润色文本\n";
        let prompts = parse_csv_prompts(csv);
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].name, "润色助手");
        assert_eq!(prompts[0].content, "请润色文本");
    }

    #[test]
    fn identity_key_ignores_case_and_spaces() {
        let a = prompt("A B", "", "Content", 0, "");
        let b = prompt("a b", "", "content", 9, "2026-01-01T00:00:00.000Z");
        assert_eq!(prompt_identity_key(&a), prompt_identity_key(&b));
        let merged = merge_sanitized(vec![a], &[b]);
        assert_eq!(merged.skipped, 1);
    }
}
