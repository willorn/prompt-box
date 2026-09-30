// WebDAV 移植：对齐 main.js 的 9 个 webdav-* handler + scheduleAutoBackup。
// 忠实语义：config trim/默认值、settings clamp、坚果云代理 URL 修正、
// 备份文件名本地时间戳、目录存在性判断、lastmod 降序取最新。

use chrono::{DateTime, Local, Utc};
use reqwest_dav::types::list_cmd::ListEntity;
use reqwest_dav::{Auth, Client, ClientBuilder, Depth};
use serde_json::{json, Value};

use crate::helpers;

// —— 配置（getWebdavConfig / getWebdavSettings / ensureWebdavConfig / webdav-set-*）——

pub fn get_config(webdav: &Value) -> Value {
    let str_field = |key: &str| webdav.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let directory = str_field("directory");
    json!({
        "url": str_field("url"),
        "username": str_field("username"),
        "password": str_field("password"),
        // Electron: config.directory || "prompt-box-backups"（空串回默认）
        "directory": if directory.is_empty() { "prompt-box-backups" } else { directory },
    })
}

pub fn get_settings(webdav: &Value) -> Value {
    // autoBackupEnabled !== false（缺失/true/null 均 → true）
    let enabled = webdav
        .get("autoBackupEnabled")
        .and_then(|v| v.as_bool())
        != Some(false);
    // Number(config.intervalDays || 3)：缺失/0 → 3
    let days = webdav
        .get("intervalDays")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let days = if days == 0.0 { 3.0 } else { days };
    let last = webdav
        .get("lastAutoBackupAt")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    json!({
        "autoBackupEnabled": enabled,
        "intervalDays": days,
        "lastAutoBackupAt": last,
    })
}

pub fn ensure_config(webdav: &Value) -> Result<Value, String> {
    let mut config = get_config(webdav);
    if config["url"]
        .as_str()
        .is_some_and(|u| u.contains("jianguoyun-dav-proxy"))
    {
        config["url"] = json!("https://dav.jianguoyun.com/dav/");
    }
    let url = config["url"].as_str().unwrap_or("").to_string();
    if url.is_empty()
        || config["username"].as_str().unwrap_or("").is_empty()
        || config["password"].as_str().unwrap_or("").is_empty()
    {
        return Err("请先配置 WebDAV".into());
    }
    if url.starts_with('/') {
        return Err("WebDAV 地址需要完整 URL（如 https://dav.jianguoyun.com/dav/）".into());
    }
    Ok(config)
}

// webdav-set-config：先 || 默认再 trim（空格串 directory 会 trim 成 ""，照搬 Electron 时序）
pub fn config_fields_to_store(config: &Value) -> Value {
    let str_field = |key: &str, fallback: &str| -> String {
        config
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or(fallback)
            .trim()
            .to_string()
    };
    json!({
        "url": str_field("url", ""),
        "username": str_field("username", ""),
        "password": str_field("password", ""),
        "directory": str_field("directory", "prompt-box-backups"),
    })
}

// webdav-set-settings：enabled !== false；intervalDays clamp 1..30
pub fn settings_fields_to_store(settings: &Value) -> Result<Value, String> {
    if !settings.is_object() {
        return Err("invalid settings".into());
    }
    let enabled = settings
        .get("autoBackupEnabled")
        .and_then(|v| v.as_bool())
        != Some(false);
    let days = settings
        .get("intervalDays")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let days = if days == 0.0 { 3.0 } else { days };
    let days = days.max(1.0).min(30.0);
    Ok(json!({ "autoBackupEnabled": enabled, "intervalDays": days }))
}

// —— 路径与文件名（normalizeDir / buildBackupFilename）——

pub fn normalize_dir(dir: &str) -> String {
    // Electron: (dir || "prompt-box-backups").trim().replace(/\\+/g, "/")
    let base = if dir.is_empty() { "prompt-box-backups" } else { dir };
    let safe = collapse_backslashes(base.trim());
    if safe.is_empty() {
        return "/prompt-box-backups".to_string();
    }
    if safe.starts_with('/') {
        safe
    } else {
        format!("/{safe}")
    }
}

// /\\+/g：连续反斜杠折叠为单个 "/"
fn collapse_backslashes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_bs = false;
    for c in s.chars() {
        if c == '\\' {
            if !prev_bs {
                out.push('/');
            }
            prev_bs = true;
        } else {
            out.push(c);
            prev_bs = false;
        }
    }
    out
}

pub fn build_backup_filename(now: DateTime<Local>) -> String {
    use chrono::{Datelike, Timelike};
    format!(
        "prompt-box-backup-{:04}{:02}{:02}_{:02}{:02}{:02}.json",
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

// —— PROPFIND 响应辅助 ——

// href → basename（去查询串、去尾斜杠、最后段、百分号解码），对齐 webdav 包 FileStat.basename
pub fn href_basename(href: &str) -> String {
    let path = href.split('?').next().unwrap_or(href);
    let trimmed = path.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    percent_decode(name)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let hex = |b: u8| -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    };
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// 目录下的 .json 文件（type === "file" && basename.endsWith(".json")），lastmod 降序
fn json_files_by_recency(entities: Vec<ListEntity>) -> Vec<(String, DateTime<Utc>, i64)> {
    let mut files: Vec<(String, DateTime<Utc>, i64)> = entities
        .into_iter()
        .filter_map(|e| match e {
            ListEntity::File(f) => {
                Some((href_basename(&f.href), f.last_modified, f.content_length))
            }
            ListEntity::Folder(_) => None,
        })
        .filter(|(name, _, _)| name.ends_with(".json"))
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files
}

// —— 网络操作（backupWebdavInternal / webdav-test / webdav-restore-* / webdav-list-backups）——

fn make_client(config: &Value) -> Result<Client, String> {
    ClientBuilder::new()
        .set_host(config["url"].as_str().unwrap_or("").to_string())
        .set_auth(Auth::Basic(
            config["username"].as_str().unwrap_or("").to_string(),
            config["password"].as_str().unwrap_or("").to_string(),
        ))
        .build()
        .map_err(|e| e.to_string())
}

fn error_status(e: &reqwest_dav::Error) -> Option<u16> {
    match e {
        reqwest_dav::Error::Decode(reqwest_dav::DecodeError::StatusMismatched(se)) => {
            Some(se.response_code)
        }
        _ => None,
    }
}

// exists：404 → false，2xx → true，其他错误上抛（对齐 webdav 包 client.exists）
async fn dav_exists(client: &Client, path: &str) -> Result<bool, String> {
    match client.list(path, Depth::Number(0)).await {
        Ok(_) => Ok(true),
        Err(e) => {
            if error_status(&e) == Some(404) {
                Ok(false)
            } else {
                Err(e.to_string())
            }
        }
    }
}

pub async fn test(config: &Value) -> Result<bool, String> {
    let client = make_client(config)?;
    client
        .list("/", Depth::Number(0))
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

pub async fn backup(config: &Value, prompts: &[helpers::Prompt]) -> Result<(String, String), String> {
    let client = make_client(config)?;
    let dir = normalize_dir(config["directory"].as_str().unwrap_or(""));
    let file_name = build_backup_filename(Local::now());
    let remote_path = format!("{dir}/{file_name}");

    // createDirectory 已存在时忽略
    let _ = client.mkcol(&dir).await;

    let payload = json!({
        "version": "1.0",
        "exportedAt": helpers::now_iso8601(),
        "prompts": prompts,
    });
    let content = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    client.put(&remote_path, content).await.map_err(|e| e.to_string())?;
    Ok((remote_path, file_name))
}

// 恢复必须拒绝无效记录，不能把格式错误当成空备份。
pub fn validate_backup_prompts(payload: &Value) -> Result<Vec<helpers::Prompt>, String> {
    let list = payload.as_array().ok_or("备份格式错误：prompts 必须是数组")?;
    list.iter().map(|item| {
        if !item.get("name").is_some_and(Value::is_string)
            || !item.get("content").is_some_and(Value::is_string) {
            return Err("备份包含无效提示词：名称和内容必须是字符串".to_string());
        }
        helpers::normalize_prompt(item).ok_or_else(|| "备份包含空名称或空内容".to_string())
    }).collect()
}

// 下载并解析备份 payload，允许裸数组或带 prompts 的对象。
async fn fetch_prompts_payload(client: &Client, remote_path: &str) -> Result<Value, String> {
    let resp = client.get(remote_path).await.map_err(|e| e.to_string())?;
    let raw = resp.text().await.map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let payload = match parsed.get("prompts") {
        Some(p) => p.clone(),
        _ => parsed,
    };
    validate_backup_prompts(&payload)?;
    Ok(payload)
}

pub async fn restore_latest(config: &Value) -> Result<(String, Value), String> {
    let client = make_client(config)?;
    let dir = normalize_dir(config["directory"].as_str().unwrap_or(""));

    if !dav_exists(&client, &dir).await? {
        return Err("未找到远程备份目录".into());
    }
    let entities = client
        .list(&dir, Depth::Number(1))
        .await
        .map_err(|e| e.to_string())?;
    let Some((latest, _, _)) = json_files_by_recency(entities).into_iter().next() else {
        return Err("未找到可用备份".into());
    };

    let remote_path = format!("{dir}/{latest}");
    let raw = fetch_prompts_payload(&client, &remote_path).await?;
    Ok((remote_path, raw))
}

pub async fn restore_path(config: &Value, remote_path: &str) -> Result<(String, Value), String> {
    let client = make_client(config)?;
    let raw = fetch_prompts_payload(&client, remote_path).await?;
    Ok((remote_path.to_string(), raw))
}

pub async fn list_backups(config: &Value) -> Result<Vec<Value>, String> {
    let client = make_client(config)?;
    let dir = normalize_dir(config["directory"].as_str().unwrap_or(""));

    if !dav_exists(&client, &dir).await? {
        return Ok(Vec::new());
    }
    let entities = client
        .list(&dir, Depth::Number(1))
        .await
        .map_err(|e| e.to_string())?;
    Ok(json_files_by_recency(entities)
        .into_iter()
        .map(|(name, last_modified, size)| {
            json!({
                "name": name,
                "path": format!("{dir}/{name}"),
                "lastMod": last_modified.to_rfc2822(),
                "size": size,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_validation_rejects_invalid_shapes_and_records() {
        for payload in [json!({}), json!(null), json!({"prompts": null}), json!([{}]), json!([{"name": "A", "content": 42}]), json!([{"name": "A", "content": " "}]), json!([{"name": "A", "content": "valid"}, {}])] {
            assert!(validate_backup_prompts(&payload).is_err(), "{payload}");
        }
        assert!(validate_backup_prompts(&json!([])).unwrap().is_empty());
        assert_eq!(validate_backup_prompts(&json!([{"name": "A", "content": "valid"}])).unwrap().len(), 1);
    }

    #[test]
    fn normalize_dir_defaults_and_slashes() {
        assert_eq!(normalize_dir(""), "/prompt-box-backups");
        assert_eq!(normalize_dir("  "), "/prompt-box-backups");
        assert_eq!(normalize_dir("foo"), "/foo");
        assert_eq!(normalize_dir("/foo"), "/foo");
        assert_eq!(normalize_dir(" foo\\bar "), "/foo/bar");
        // 连续反斜杠折叠为单个斜杠（/\\+/g）
        assert_eq!(normalize_dir("a\\\\b"), "/a/b");
    }

    #[test]
    fn backup_filename_format() {
        use chrono::TimeZone;
        let now = Local
            .with_ymd_and_hms(2026, 8, 23, 18, 42, 7)
            .unwrap();
        assert_eq!(
            build_backup_filename(now),
            "prompt-box-backup-20260823_184207.json"
        );
    }

    #[test]
    fn config_defaults() {
        let c = get_config(&json!({}));
        assert_eq!(c["directory"], "prompt-box-backups");
        assert_eq!(c["url"], "");

        let c = get_config(&json!({ "directory": "my-dir", "url": "https://dav.example.com" }));
        assert_eq!(c["directory"], "my-dir");
        // 空串 directory 回默认
        let c = get_config(&json!({ "directory": "" }));
        assert_eq!(c["directory"], "prompt-box-backups");
    }

    #[test]
    fn ensure_config_validation() {
        assert_eq!(ensure_config(&json!({})), Err("请先配置 WebDAV".to_string()));
        assert_eq!(
            ensure_config(&json!({ "url": "https://dav.jianguoyun.com/dav/", "username": "u", "password": "" })),
            Err("请先配置 WebDAV".to_string())
        );
        assert_eq!(
            ensure_config(&json!({ "url": "/dav/", "username": "u", "password": "p" })),
            Err("WebDAV 地址需要完整 URL（如 https://dav.jianguoyun.com/dav/）".to_string())
        );
        // 坚果云代理 URL 修正
        let c = ensure_config(&json!({
            "url": "https://jianguoyun-dav-proxy.example.com/dav/",
            "username": "u",
            "password": "p"
        }))
        .unwrap();
        assert_eq!(c["url"], "https://dav.jianguoyun.com/dav/");
        // 完整配置原样通过
        let c = ensure_config(&json!({
            "url": "https://dav.example.com/dav/",
            "username": "u",
            "password": "p",
            "directory": "dir"
        }))
        .unwrap();
        assert_eq!(c["directory"], "dir");
    }

    #[test]
    fn set_config_trims_and_defaults() {
        let f = config_fields_to_store(&json!({
            "url": "  https://dav.example.com  ",
            "username": " u ",
            "password": " p ",
            "directory": "  ",
        }));
        assert_eq!(f["url"], "https://dav.example.com");
        assert_eq!(f["username"], "u");
        assert_eq!(f["password"], "p");
        // Electron 先 || 默认再 trim：空格串 truthy → trim 后空串
        assert_eq!(f["directory"], "");
        let f = config_fields_to_store(&json!({}));
        assert_eq!(f["directory"], "prompt-box-backups");
    }

    #[test]
    fn settings_defaults_and_clamp() {
        let s = get_settings(&json!({}));
        assert_eq!(s["autoBackupEnabled"], true);
        assert_eq!(s["intervalDays"], 3.0);
        assert_eq!(s["lastAutoBackupAt"], 0.0);

        // !== false：缺失 → true；false → false
        let f = settings_fields_to_store(&json!({ "autoBackupEnabled": false, "intervalDays": 0 }))
            .unwrap();
        assert_eq!(f["autoBackupEnabled"], false);
        assert_eq!(f["intervalDays"], 3.0);

        let f = settings_fields_to_store(&json!({ "intervalDays": 99 })).unwrap();
        assert_eq!(f["intervalDays"], 30.0);
        let f = settings_fields_to_store(&json!({ "intervalDays": -5 })).unwrap();
        assert_eq!(f["intervalDays"], 1.0);
        let f = settings_fields_to_store(&json!({ "intervalDays": 2.5 })).unwrap();
        assert_eq!(f["intervalDays"], 2.5);

        assert!(settings_fields_to_store(&json!("nope")).is_err());
    }

    #[test]
    fn href_basename_extraction() {
        assert_eq!(
            href_basename("/dav/prompt-box-backups/prompt-box-backup-20260823_184207.json"),
            "prompt-box-backup-20260823_184207.json"
        );
        assert_eq!(href_basename("/dav/dir/my%20file.json"), "my file.json");
        assert_eq!(href_basename("/dav/dir/"), "dir");
        // 非法百分号序列原样保留
        assert_eq!(href_basename("/dav/dir/100%.json"), "100%.json");
    }
}
