// Tauri 桥接层：等价替代 Electron preload.cjs 的 window.electronAPI。
// 通过 Tauri 的 initialization_script 注入（先于页面脚本执行），index.html / renderer.js 零改动。
// Electron 环境下 preload 已定义 electronAPI，本脚本直接退出，两版可共用同一套前端。
(() => {
  if (window.electronAPI) return;

  // 惰性取 __TAURI__：注入时序上 Tauri 核心先于本脚本，但惰性更稳。
  const inv = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

  window.electronAPI = {
    // —— 窗口行为 ——
    minimizeWindow: () => inv("minimize_window"),
    suppressBlurHide: (ms) => inv("suppress_blur_hide", { ms }),
    setBlurHideLocked: (locked) => inv("set_blur_hide_locked", { locked }),

    // —— 粘贴主路径 ——
    copyPastePrompt: (text) => inv("copy_paste_prompt", { text }),
    writeClipboard: (text) => inv("write_clipboard", { text }),

    // —— 数据（prompts / 隐藏分类）——
    getPrompts: () => inv("get_prompts"),
    setPrompts: (prompts) => inv("set_prompts", { prompts }),
    getHiddenTags: () => inv("get_hidden_tags"),
    setHiddenTags: (tags) => inv("set_hidden_tags", { tags }),

    // —— 快捷键 ——
    getHotkeyInfo: () => inv("get_hotkey_info"),
    cycleGlobalHotkey: () => inv("cycle_global_hotkey"),
    pinActiveGlobalHotkey: () => inv("pin_active_global_hotkey"),
    setPreferredGlobalHotkey: (accelerator) =>
      inv("set_preferred_global_hotkey", { accelerator }),

    // —— 应用信息 / 权限 ——
    getAppInfo: () => inv("get_app_info"),
    getPermissionDiagnostics: () => inv("get_permission_diagnostics"),
    openAccessibilitySettings: () => inv("open_accessibility_settings"),
    openAutomationSettings: () => inv("open_automation_settings"),

    // —— 安全快照（PoC 最小实现）——
    listSafetySnapshots: () => inv("list_safety_snapshots"),
    restoreLatestSafetySnapshot: () => inv("restore_latest_safety_snapshot"),

    // —— 系统设置（PoC 最小实现）——
    getOpenAtLogin: () => inv("get_open_at_login"),
    setOpenAtLogin: (enabled) => inv("set_open_at_login", { enabled }),
    showNotification: (payload) => inv("show_notification", { payload }),

    // —— 导入导出（阶段 3）——
    chooseExportFormat: () => inv("choose_export_format"),
    exportPrompts: (payload) => inv("export_prompts", { payload }),
    importPrompts: () => inv("import_prompts"),
    chooseImportMode: (payload) => inv("choose_import_mode", { payload }),

    // —— WebDAV（阶段 4）——
    getWebdavConfig: () => inv("get_webdav_config"),
    setWebdavConfig: (config) => inv("set_webdav_config", { config }),
    getWebdavSettings: () => inv("get_webdav_settings"),
    setWebdavSettings: (settings) => inv("set_webdav_settings", { settings }),
    testWebdav: () => inv("test_webdav"),
    backupWebdav: () => inv("backup_webdav"),
    restoreWebdavLatest: () => inv("restore_webdav_latest"),
    restoreWebdavPath: (remotePath) =>
      inv("restore_webdav_path", { remotePath }),
    listWebdavBackups: () => inv("list_webdav_backups"),

    // —— WKWebView 无 JS alert/confirm 面板：safeAlert/safeConfirm 的原生替代 ——
    showAlertDialog: (message) => inv("show_alert_dialog", { message }),
    showConfirmDialog: (message) => inv("show_confirm_dialog", { message }),

    // —— 权限（唤起主动请求 + 面板状态）——
    probeAutomationPermission: () => inv("probe_automation_permission"),
    requestAccessibilityPrompt: () => inv("request_accessibility_prompt"),

    // —— 事件：Tauri event 适配 ipcRenderer.on ——
    onFocusSearch: (handler) =>
      window.__TAURI__.event.listen("focus-search", () => handler()),
    onManageLayerBlocksHide: (handler) =>
      window.__TAURI__.event.listen("manage-layer-blocks-hide", () =>
        handler(),
      ),
    onPrepareQuit: (handler) =>
      window.__TAURI__.event.listen("prepare-quit", () => handler()),
    prepareQuitDone: () => inv("prepare_quit_done"),
    onAutoBackup: (handler) =>
      window.__TAURI__.event.listen("auto-backup", (e) => handler(e.payload)),
  };
})();
