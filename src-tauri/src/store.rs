// 存储：JSON 单文件，形状与 electron-store 兼容（prompts / hiddenTags / 偏好）。
// sanitize 已升级为 helpers.rs 的完整移植（sanitizePromptList 全语义）。

use crate::helpers;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub struct Store {
    path: PathBuf,
    data: Value,
    persisted: Value,
}

fn default_sample_prompts() -> Value {
    // 与 lib/prompt-helpers.js getDefaultSamplePrompts 保持一致（基线 20/33：首启种子、示例置顶）。
    serde_json::to_value(helpers::get_default_sample_prompts()).unwrap_or_else(|_| json!([]))
}

fn prompts_to_value(list: &[helpers::Prompt]) -> Value {
    serde_json::to_value(list).unwrap_or_else(|_| json!([]))
}

const MAX_SAFETY_SNAPSHOTS: usize = 5;

// 内容集合指纹：与 Electron promptsIdentitySignature 一致（排序后的 name+content 键）
fn prompts_identity_signature(list: &[helpers::Prompt]) -> String {
    let mut keys: Vec<String> = list.iter().map(helpers::prompt_identity_key).collect();
    keys.sort();
    keys.join("\n")
}

impl Store {
    pub fn load(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = app
            .path()
            .app_config_dir()
            ?;
        fs::create_dir_all(&dir)?;
        let path = dir.join("store.json");
        Self::load_path(path)
    }

    fn load_path(path: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let data = match fs::read_to_string(&path) {
            Ok(raw) => {
                let value: Value = serde_json::from_str(&raw)?;
                if !value.is_object() {
                    return Err("store.json must contain an object; original file preserved".into());
                }
                value
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => json!({}),
            Err(err) => return Err(err.into()),
        };
        Ok(Self { path, persisted: data.clone(), data })
    }

    fn save(&mut self) -> Result<(), String> {
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let raw = serde_json::to_vec_pretty(&self.data)?;
            let parent = self.path.parent().ok_or("invalid store path")?;
            let mut temp = tempfile::NamedTempFile::new_in(parent)?;
            temp.write_all(&raw)?;
            temp.as_file().sync_all()?;
            temp.persist(&self.path)?;
            Ok(())
        })();
        match result {
            Ok(()) => { self.persisted = self.data.clone(); Ok(()) }
            Err(err) => { self.data = self.persisted.clone(); Err(err.to_string()) }
        }
    }

    // —— prompts：首次启动回种示例；空数组视为用户已清空，不再回种 ——
    pub fn get_prompts(&mut self) -> Result<Value, String> {
        let needs_seed = match self.data.get("prompts") {
            None => true,
            Some(v) if !v.is_array() => true,
            _ => false,
        };
        if needs_seed {
            let seeded = default_sample_prompts();
            self.data["prompts"] = seeded.clone();
            self.save()?;
            return Ok(seeded);
        }
        Ok(prompts_to_value(&helpers::sanitize_prompt_list(&self.data["prompts"])))
    }

    pub fn set_prompts(&mut self, prompts: Value) -> Result<Value, String> {
        let sanitized = helpers::sanitize_prompt_list(&prompts);
        // 内容集合变化才快照；纯 useCount/lastUsedAt 更新不占用安全快照（对齐 Electron set-prompts）
        let existing = self.data.get("prompts").cloned().unwrap_or(Value::Null);
        if existing.is_array() {
            let prev = helpers::sanitize_prompt_list(&existing);
            if !prev.is_empty()
                && prompts_identity_signature(&prev) != prompts_identity_signature(&sanitized)
            {
                self.push_safety_snapshot(&existing, false)?;
            }
        }
        self.write_prompts(&sanitized)
    }

    pub fn write_prompts(&mut self, list: &[helpers::Prompt]) -> Result<Value, String> {
        let v = prompts_to_value(list);
        self.data["prompts"] = v.clone();
        self.save()?;
        Ok(v)
    }

    pub fn prompts_raw(&self) -> Value {
        self.data
            .get("prompts")
            .cloned()
            .unwrap_or_else(|| json!([]))
    }

    // —— 安全快照（基线：内容集合变化自动存档，最多 5 份，可回退）——

    pub fn get_safety_snapshots(&self) -> Vec<Value> {
        match self.data.get("safetySnapshots") {
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        }
    }

    pub fn push_safety_snapshot(&mut self, prompts: &Value, force: bool) -> Result<bool, String> {
        let list = helpers::sanitize_prompt_list(prompts);
        if list.is_empty() && !force {
            return Ok(false);
        }
        let fingerprint = prompts_identity_signature(&list);
        let mut snaps = self.get_safety_snapshots();
        // 与最新一份指纹相同则跳过，避免每次粘贴/使用都堆快照
        if !force
            && snaps
                .first()
                .and_then(|s| s.get("fingerprint"))
                .and_then(|v| v.as_str())
                .is_some_and(|s| s == fingerprint)
        {
            return Ok(false);
        }
        snaps.insert(
            0,
            json!({
                "at": helpers::now_iso8601(),
                "count": list.len(),
                "fingerprint": fingerprint,
                "prompts": prompts_to_value(&list),
            }),
        );
        snaps.truncate(MAX_SAFETY_SNAPSHOTS);
        self.data["safetySnapshots"] = Value::Array(snaps);
        self.save()?;
        Ok(true)
    }

    pub fn list_safety_snapshots(&self) -> Value {
        Value::Array(
            self.get_safety_snapshots()
                .iter()
                .enumerate()
                .map(|(index, snap)| {
                    json!({
                        "index": index,
                        "at": snap.get("at").and_then(|v| v.as_str()).unwrap_or(""),
                        "count": snap.get("count").and_then(|v| v.as_i64()).unwrap_or(0),
                    })
                })
                .collect(),
        )
    }

    // —— 隐藏分类 ——
    pub fn get_hidden_tags(&mut self) -> Value {
        let v = self
            .data
            .get("hiddenTags")
            .cloned()
            .unwrap_or_else(|| json!([]));
        if !v.is_array() {
            return json!([]);
        }
        v
    }

    pub fn set_hidden_tags(&mut self, tags: Value) -> Result<Value, String> {
        let list = if tags.is_array() { tags } else { json!([]) };
        self.data["hiddenTags"] = list.clone();
        self.save()?;
        Ok(list)
    }

    // —— 偏好（快捷键等）——
    pub fn get_pref(&self, key: &str) -> Option<&Value> {
        self.data.get("prefs").and_then(|p| p.get(key))
    }

    pub fn set_pref(&mut self, key: &str, value: Value) -> Result<(), String> {
        if !self.data.get("prefs").map(|p| p.is_object()).unwrap_or(false) {
            self.data["prefs"] = json!({});
        }
        self.data["prefs"][key] = value;
        self.save()
    }

    // —— WebDAV（Electron 独立 webdavStore 的等价：单对象 merge 写，字段含 config/settings/lastAutoBackupAt）——
    pub fn webdav(&self) -> Value {
        match self.data.get("webdav") {
            Some(v) if v.is_object() => v.clone(),
            _ => json!({}),
        }
    }

    pub fn merge_webdav(&mut self, fields: Value) -> Result<(), String> {
        if !self.data.get("webdav").map(|v| v.is_object()).unwrap_or(false) {
            self.data["webdav"] = json!({});
        }
        if let Some(obj) = fields.as_object() {
            for (key, value) in obj {
                self.data["webdav"][key] = value.clone();
            }
            self.save()?;
        }
        Ok(())
    }

    // —— 窗口几何（逻辑坐标）——
    pub fn get_window_bounds(&self) -> Option<(f64, f64, f64, f64)> {
        let b = self.data.get("windowBounds")?;
        Some((
            b["x"].as_f64()?,
            b["y"].as_f64()?,
            b["width"].as_f64().unwrap_or(1000.0),
            b["height"].as_f64().unwrap_or(700.0),
        ))
    }

    pub fn set_window_bounds(&mut self, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
        self.data["windowBounds"] = json!({ "x": x, "y": y, "width": width, "height": height });
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::load_path(dir.path().join("store.json")).unwrap();
        (dir, store)
    }

    #[test]
    fn safety_snapshot_dedupe_and_cap() {
        let (_dir, mut s) = test_store();
        let p1 = json!([{ "name": "A", "content": "1" }]);
        assert!(s.push_safety_snapshot(&p1, false).unwrap());
        assert!(!s.push_safety_snapshot(&p1, false).unwrap()); // 同指纹跳过
        assert!(s.push_safety_snapshot(&json!([{ "name": "B", "content": "2" }]), false).unwrap());
        assert!(s.push_safety_snapshot(&p1, true).unwrap()); // force 一定落
        assert_eq!(s.get_safety_snapshots().len(), 3);

        for i in 0..5 {
            // 指纹相同但 force：验证 5 份上限截断
            s.push_safety_snapshot(&json!([{ "name": "X", "content": "x", "note": i }]), true).unwrap();
        }
        assert_eq!(s.get_safety_snapshots().len(), 5);
    }

    #[test]
    fn set_prompts_snapshots_on_content_change_only() {
        let (_dir, mut s) = test_store();
        s.set_prompts(json!([{ "name": "A", "content": "1", "useCount": 1 }])).unwrap();
        assert_eq!(s.get_safety_snapshots().len(), 0); // 原本为空，不快照

        // 纯 useCount 变化：不快照（对齐 Electron prevSig !== nextSig 才存）
        s.set_prompts(json!([{ "name": "A", "content": "1", "useCount": 9 }])).unwrap();
        assert_eq!(s.get_safety_snapshots().len(), 0);

        // 内容集合变化：快照旧数据
        s.set_prompts(json!([{ "name": "A", "content": "changed" }])).unwrap();
        assert_eq!(s.get_safety_snapshots().len(), 1);
        assert_eq!(s.get_safety_snapshots()[0]["count"], 1);
    }

    #[test]
    fn failed_writes_restore_memory_and_preserve_previous_file() {
        let (dir, mut s) = test_store();
        s.set_prompts(json!([{"name": "A", "content": "old"}])).unwrap();
        let original_path = s.path.clone();
        let original = fs::read(&original_path).unwrap();
        let before = s.data.clone();
        // 以目录代替目标文件，确定性触发原子替换失败（不依赖运行用户权限）。
        s.path = dir.path().join("blocked");
        fs::create_dir(&s.path).unwrap();
        assert!(s.set_prompts(json!([{"name": "B", "content": "new"}])).is_err());
        assert_eq!(s.data, before);
        assert!(s.set_hidden_tags(json!(["hidden"])).is_err());
        assert!(s.set_pref("preferredGlobalHotkey", json!("Alt+Space")).is_err());
        assert!(s.merge_webdav(json!({"url": "https://example.invalid"})).is_err());
        assert!(s.set_window_bounds(1.0, 2.0, 900.0, 700.0).is_err());
        assert_eq!(s.data, before);
        assert_eq!(fs::read(original_path).unwrap(), original);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn corrupt_store_is_preserved_and_missing_store_seeds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.json");
        for raw in ["{broken", "[]", "null"] {
            fs::write(&path, raw).unwrap();
            assert!(Store::load_path(path.clone()).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), raw);
        }
        let missing = dir.path().join("new.json");
        let mut s = Store::load_path(missing.clone()).unwrap();
        assert!(!s.get_prompts().unwrap().as_array().unwrap().is_empty());
        s.set_prompts(json!([])).unwrap();
        assert_eq!(Store::load_path(missing).unwrap().get_prompts().unwrap(), json!([]));
    }
}
