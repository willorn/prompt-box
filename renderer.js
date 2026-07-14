import {
  normalizePrompt,
  sanitizePromptList,
  promptIdentityKey,
  mergePromptLists,
  parseMarkdownPrompts,
  parseCsvRows,
  parseCsvPrompts,
  extractPromptsFromImport,
  escapeHtml,
  promptMatchesSearch,
  highlightMatch,
  clonePromptList,
  normalizeTag,
  toTimestamp,
  formatRelativeTime,
  getUsageSummary,
  comparePromptsForUse,
  scorePromptMatch,
  comparePromptsForSearch,
  markPromptUsed,
  formatPromptAsMarkdown,
  formatPromptAsJson,
  formatPromptShareText,
  formatPromptsAsMarkdown,
  formatPromptsAsCsv,
  formatPromptsAsJson,
  detectImportFormatFromPath,
  getDefaultSamplePrompts,
} from "./lib/prompt-helpers.js";

const DEFAULT_PROMPTS = getDefaultSamplePrompts();

const electronAPI = window.electronAPI;

function assertElectron() {
  if (!electronAPI) {
    throw new Error("Electron API 不可用");
  }
}

async function pauseBlurHide(ms = 8000) {
  try {
    if (electronAPI?.suppressBlurHide) {
      await electronAPI.suppressBlurHide(ms);
    }
  } catch {
    // 开发态或 API 缺失时忽略，不阻断业务路径。
  }
}

async function safeAlert(message) {
  await pauseBlurHide(10000);
  alert(String(message ?? ""));
}

async function safeConfirm(message) {
  await pauseBlurHide(10000);
  return confirm(String(message ?? ""));
}

async function loadPrompts() {
  try {
    assertElectron();
    const stored = await electronAPI.getPrompts();
    if (!Array.isArray(stored)) {
      return DEFAULT_PROMPTS.slice();
    }
    const sanitized = sanitizePromptList(stored);
    if (sanitized.length === 0 && stored.length > 0) {
      // Stored data existed but failed sanitization; keep sample prompts usable.
      return DEFAULT_PROMPTS.slice();
    }
    return sanitized;
  } catch {
    return DEFAULT_PROMPTS.slice();
  }
}

async function persistPrompts(list) {
  assertElectron();
  await electronAPI.setPrompts(sanitizePromptList(list));
}

async function copyText(text) {
  const value = String(text ?? "");
  // 优先主进程剪贴板：与粘贴路径一致，少受渲染进程权限/焦点影响。
  try {
    if (electronAPI?.writeClipboard) {
      await electronAPI.writeClipboard(value);
      return true;
    }
  } catch (err) {
    console.error("主进程写入剪贴板失败，回退浏览器接口", err);
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

async function copyPromptForUse(text) {
  const value = String(text ?? "");
  if (!value) {
    return { copied: false, pasted: false };
  }
  try {
    assertElectron();
    if (electronAPI?.copyPastePrompt) {
      return await electronAPI.copyPastePrompt(value);
    }
  } catch (err) {
    console.error("主进程复制粘贴失败，回退为仅复制", err);
  }

  const copied = await copyText(value);
  return { copied, pasted: false };
}

// Lucide 风格线框图钉（未置顶描边 / 已置顶填充）
const PREVIEW_PIN_ICON =
  '<svg class="preview-action-svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
const PREVIEW_PIN_ICON_ACTIVE =
  '<svg class="preview-action-svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

function setPreviewActionButtonLabel(button, label, titleSuffix = "") {
  if (!button) return;
  const nextLabel = String(label ?? "").trim();
  const labelEl = button.querySelector(".preview-action-label");
  if (labelEl) {
    labelEl.textContent = nextLabel;
  }
  button.setAttribute("aria-label", nextLabel);
  const suffix = String(titleSuffix || "").trim();
  button.title = suffix ? `${nextLabel} ${suffix}` : nextLabel;

  // 置顶按钮：同步 aria-pressed、图标填充态，避免文字标签抢布局。
  if (button.id === "previewPin") {
    const pinned = nextLabel.includes("取消");
    button.classList.toggle("is-pinned", pinned);
    button.setAttribute("aria-pressed", pinned ? "true" : "false");
    const iconHost = button.querySelector(".preview-action-icon");
    if (iconHost) {
      iconHost.innerHTML = pinned ? PREVIEW_PIN_ICON_ACTIVE : PREVIEW_PIN_ICON;
    }
  }
}

async function openAccessibilitySettings() {
  try {
    assertElectron();
    await electronAPI?.openAccessibilitySettings?.();
  } catch (err) {
    console.error("打开辅助功能设置失败", err);
  }
}

async function openAutomationSettings() {
  try {
    assertElectron();
    await electronAPI?.openAutomationSettings?.();
  } catch (err) {
    console.error("打开自动化设置失败", err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const navItemsContainer = document.getElementById("sidebar");
  const cardGrid = document.getElementById("cardGrid");
  const searchInput = document.getElementById("searchInput");
  const searchClearBtn = document.getElementById("searchClearBtn");
  const modal = document.getElementById("modalOverlay");
  const modalTitle = modal.querySelector("h2");
  const settingsBtn = document.getElementById("settingsBtn");
  const headerSettingsBtn = document.getElementById("headerSettingsBtn");
  const headerAddBtn = document.getElementById("headerAddBtn");

  const previewPanel = document.getElementById("previewPanel");
  const previewTitle = document.getElementById("previewTitle");
  const previewBody = document.getElementById("previewBody");
  const previewUsageStats = document.getElementById("previewUsageStats");
  const previewUse = document.getElementById("previewUse");
  const previewShare = document.getElementById("previewShare");
  const previewPin = document.getElementById("previewPin");
  const previewEdit = document.getElementById("previewEdit");
  const previewDelete = document.getElementById("previewDelete");
  const previewToggleBtn = document.getElementById("previewToggleBtn");
  const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
  const sidebarToggleLabel = document.getElementById("sidebarToggleLabel");

  const PREVIEW_COLLAPSE_KEY = "promptbox.previewCollapsed";
  const SIDEBAR_COLLAPSE_KEY = "promptbox.sidebarCollapsed";
  const THEME_MODE_KEY = "promptbox.themeMode";
  let previewCollapsed = false;
  let sidebarCollapsed = false;
  let themeMode = "system"; // light | dark | system
  let systemThemeMql = null;

  function loadPreviewCollapsed() {
    try {
      const raw = window.localStorage.getItem(PREVIEW_COLLAPSE_KEY);
      // 首次使用默认收起预览，调用层更像启动器；用户点过 [ 后记住偏好。
      if (raw === null) return true;
      return raw === "1";
    } catch {
      return true;
    }
  }

  function loadSidebarCollapsed() {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
      // 首次默认收起侧栏，主区域留给搜索/列表；需要整理时再展开。
      if (raw === null) return true;
      return raw === "1";
    } catch {
      return true;
    }
  }

  function persistSidebarCollapsed(value) {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, value ? "1" : "0");
    } catch {}
  }

  function applySidebarCollapsed() {
    document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed);
    const sidebar = document.getElementById("sidebar");
    if (sidebar) {
      sidebar.setAttribute("aria-hidden", sidebarCollapsed ? "true" : "false");
      if ("inert" in sidebar) sidebar.inert = sidebarCollapsed;
    }
    if (sidebarToggleBtn) {
      sidebarToggleBtn.setAttribute("aria-pressed", sidebarCollapsed ? "true" : "false");
      sidebarToggleBtn.title = sidebarCollapsed ? "展开侧栏 ( ] )" : "收起侧栏 ( ] )";
      sidebarToggleBtn.setAttribute(
        "aria-label",
        sidebarCollapsed ? "展开侧栏" : "收起侧栏",
      );
    }
    if (sidebarToggleLabel) {
      sidebarToggleLabel.textContent = "侧栏";
    }
    if (sidebarCollapsed) {
      try { setSystemMenuOpen(false); } catch {}
    }
  }

  function toggleSidebarCollapsed(force) {
    sidebarCollapsed = typeof force === "boolean" ? force : !sidebarCollapsed;
    persistSidebarCollapsed(sidebarCollapsed);
    applySidebarCollapsed();
  }

  function loadThemeMode() {
    try {
      const mode = window.localStorage.getItem(THEME_MODE_KEY) || "system";
      return mode === "light" || mode === "dark" || mode === "system" ? mode : "system";
    } catch {
      return "system";
    }
  }

  function persistThemeMode(mode) {
    try {
      window.localStorage.setItem(THEME_MODE_KEY, mode);
    } catch {}
  }

  function getSystemPrefersDark() {
    try {
      return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true;
    } catch {
      return false;
    }
  }

  function resolveThemeDark(mode = themeMode) {
    if (mode === "dark") return true;
    if (mode === "light") return false;
    return getSystemPrefersDark();
  }

  function themeModeLabel(mode = themeMode) {
    if (mode === "dark") return "深色";
    if (mode === "light") return "浅色";
    return "跟随系统";
  }

  function applyThemeMode(mode = themeMode) {
    themeMode = mode;
    const dark = resolveThemeDark(mode);
    document.documentElement.setAttribute("data-theme", mode);
    document.body.classList.toggle("theme-dark", dark);
    if (menuTheme) {
      menuTheme.textContent = `主题：${themeModeLabel(mode)}`;
      menuTheme.setAttribute("aria-label", `切换主题，当前：${themeModeLabel(mode)}`);
      menuTheme.title = "点击切换：跟随系统 → 浅色 → 深色";
    }
  }

  function cycleThemeMode() {
    const order = ["system", "light", "dark"];
    const idx = order.indexOf(themeMode);
    const next = order[(idx + 1) % order.length];
    persistThemeMode(next);
    applyThemeMode(next);
    showToast(`已切换主题：${themeModeLabel(next)}`);
  }

  async function refreshOpenAtLoginMenu() {
    if (!menuOpenAtLogin) return;
    let enabled = false;
    try {
      if (electronAPI?.getOpenAtLogin) {
        const result = await electronAPI.getOpenAtLogin();
        enabled = result?.openAtLogin === true;
      }
    } catch (err) {
      console.error("读取登录启动设置失败", err);
    }
    menuOpenAtLogin.textContent = `登录时启动：${enabled ? "开启" : "关闭"}`;
    menuOpenAtLogin.setAttribute(
      "aria-label",
      enabled ? "登录时启动已开启，点击关闭" : "登录时启动已关闭，点击开启",
    );
    menuOpenAtLogin.dataset.enabled = enabled ? "1" : "0";
  }

  
  function formatHotkeyLabel(info) {
    const active = String(info?.active || "Alt+E");
    if (info?.isFallback) {
      return `全局快捷键：${active}（已回退）`;
    }
    return `全局快捷键：${active}`;
  }

  async function refreshHotkeyMenu() {
    if (!menuHotkey) return;
    let info = { active: "Alt+E", preferred: "Alt+E", isFallback: false };
    try {
      if (electronAPI?.getHotkeyInfo) {
        const remote = await electronAPI.getHotkeyInfo();
        if (remote && typeof remote === "object") info = { ...info, ...remote };
      }
    } catch (err) {
      console.error("读取快捷键信息失败", err);
    }
    menuHotkey.textContent = formatHotkeyLabel(info);
    menuHotkey.setAttribute(
      "aria-label",
      info.isFallback
        ? `全局快捷键已回退为 ${info.active}，点击固定`
        : `全局快捷键 ${info.active}，点击切换`,
    );
    menuHotkey.title = info.isFallback
      ? "偏好键不可用。点击：固定当前回退键。再点可切换其它候选。"
      : "点击切换全局快捷键候选（Alt+E / Alt+Space / ⌥⌘P / ⌘⇧.）";
  }

  async function toggleOpenAtLogin() {
    const currentlyOn = menuOpenAtLogin?.dataset.enabled === "1";
    const next = !currentlyOn;
    try {
      assertElectron();
      const result = await electronAPI?.setOpenAtLogin?.(next);
      const enabled = result?.openAtLogin === true;
      if (menuOpenAtLogin) {
        menuOpenAtLogin.dataset.enabled = enabled ? "1" : "0";
        menuOpenAtLogin.textContent = `登录时启动：${enabled ? "开启" : "关闭"}`;
      }
      showToast(enabled ? "已开启登录时启动" : "已关闭登录时启动");
    } catch (err) {
      await safeAlert(`设置登录启动失败: ${err?.message || err}`);
      await refreshOpenAtLoginMenu();
    }
  }

  function setupSystemThemeListener() {
    try {
      systemThemeMql = window.matchMedia?.("(prefers-color-scheme: dark)") || null;
      if (!systemThemeMql) return;
      const onChange = () => {
        if (themeMode === "system") applyThemeMode("system");
      };
      if (typeof systemThemeMql.addEventListener === "function") {
        systemThemeMql.addEventListener("change", onChange);
      } else if (typeof systemThemeMql.addListener === "function") {
        systemThemeMql.addListener(onChange);
      }
    } catch {}
  }

  function persistPreviewCollapsed(value) {
    try {
      window.localStorage.setItem(PREVIEW_COLLAPSE_KEY, value ? "1" : "0");
    } catch {}
  }

  function applyPreviewCollapsed() {
    document.body.classList.toggle("preview-collapsed", previewCollapsed);
    if (previewPanel) {
      previewPanel.setAttribute("aria-hidden", previewCollapsed ? "true" : "false");
      if ("inert" in previewPanel) {
        previewPanel.inert = previewCollapsed;
      }
    }
    if (previewToggleBtn) {
      previewToggleBtn.setAttribute("aria-pressed", previewCollapsed ? "true" : "false");
      previewToggleBtn.title = previewCollapsed ? "展开预览 ( [ )" : "收起预览 ( [ )";
      previewToggleBtn.setAttribute(
        "aria-label",
        previewCollapsed ? "展开预览" : "收起预览",
      );
      const label = previewToggleBtn.querySelector(".preview-toggle-label");
      if (label) label.textContent = "预览";
    }
  }

  function togglePreviewCollapsed(force) {
    previewCollapsed = typeof force === "boolean" ? force : !previewCollapsed;
    persistPreviewCollapsed(previewCollapsed);
    applyPreviewCollapsed();
  }

  const addTagBtn = document.getElementById("addTagBtn");
  const tagInput = document.getElementById("newTag");
  const tagDropdown = document.getElementById("tagDropdown");

  const addBtn = document.getElementById("addBtn");
  const cancelBtn = document.getElementById("cancelBtn");
  const saveBtn = document.getElementById("saveBtn");
  const menuImport = document.getElementById("menuImport");
  const menuExport = document.getElementById("menuExport");
  const menuSafetyRestore = document.getElementById("menuSafetyRestore");
  const menuWebdav = document.getElementById("menuWebdav");
  const menuHiddenTags = document.getElementById("menuHiddenTags");
  const menuPermissions = document.getElementById("menuPermissions");
  const menuShortcuts = document.getElementById("menuShortcuts");
  const menuAbout = document.getElementById("menuAbout");
  const menuTheme = document.getElementById("menuTheme");
  const menuOpenAtLogin = document.getElementById("menuOpenAtLogin");
  const menuHotkey = document.getElementById("menuHotkey");
  const moreMenu = document.getElementById("moreMenu");
  const webdavOverlay = document.getElementById("webdavOverlay");
  const webdavUrl = document.getElementById("webdavUrl");
  const webdavUsername = document.getElementById("webdavUsername");
  const webdavPassword = document.getElementById("webdavPassword");
  const webdavDir = document.getElementById("webdavDir");
  const webdavConfigJson = document.getElementById("webdavConfigJson");
  const webdavRestorePath = document.getElementById("webdavRestorePath");
  const webdavTest = document.getElementById("webdavTest");
  const webdavAutoBackup = document.getElementById("webdavAutoBackup");
  const webdavIntervalDays = document.getElementById("webdavIntervalDays");
  const webdavBackupList = document.getElementById("webdavBackupList");
  const webdavRefresh = document.getElementById("webdavRefresh");
  const webdavCopyConfig = document.getElementById("webdavCopyConfig");
  const webdavPasteConfig = document.getElementById("webdavPasteConfig");
  const webdavBackup = document.getElementById("webdavBackup");
  const webdavRestore = document.getElementById("webdavRestore");
  const webdavClose = document.getElementById("webdavClose");

  const hiddenTagsOverlay = document.getElementById("hiddenTagsOverlay");
  const hiddenTagsList = document.getElementById("hiddenTagsList");
  const hiddenTagsEmpty = document.getElementById("hiddenTagsEmpty");
  const hiddenTagsClose = document.getElementById("hiddenTagsClose");
  const hiddenTagsCancel = document.getElementById("hiddenTagsCancel");
  const hiddenTagsSave = document.getElementById("hiddenTagsSave");

  const renameTagOverlay = document.getElementById("renameTagOverlay");
  const renameTagInput = document.getElementById("renameTagInput");
  const renameTagError = document.getElementById("renameTagError");
  const renameTagClose = document.getElementById("renameTagClose");
  const renameTagCancel = document.getElementById("renameTagCancel");
  const renameTagSave = document.getElementById("renameTagSave");

  // Copy/Paste Config Modal Elements
  const copyConfigOverlay = document.getElementById("copyConfigOverlay");
  const copyConfigClose = document.getElementById("copyConfigClose");
  const copyConfigText = document.getElementById("copyConfigText");
  const copyConfigBtn = document.getElementById("copyConfigBtn");
  const pasteConfigOverlay = document.getElementById("pasteConfigOverlay");
  const pasteConfigClose = document.getElementById("pasteConfigClose");
  const pasteConfigCancel = document.getElementById("pasteConfigCancel");
  const pasteConfigText = document.getElementById("pasteConfigText");
  const pasteConfigApply = document.getElementById("pasteConfigApply");

  let allPrompts = [];
  let hiddenTags = [];
  let editingIndex = null;
  let selectedIndex = null;
  // 使用后静默保存会改排序；仅在脏时于再次唤起重绘，缩短干净唤起路径。
  let needsListRefresh = true;
  // 所有落盘串行：粘贴静默保存与删除/导入/编辑不会并发 setPrompts 互相覆盖。
  let saveChain = Promise.resolve();
  let contextMenuTargetIndex = null;
  let renameTagOriginal = null;
  let pendingUndo = null;
  let toastHideTimer = null;
  let toastClearTimer = null;
  let useInFlight = false;
  let a11yTipShown = false;
  let a11ySettingsOpenedThisSession = false;
  let automationSettingsOpenedThisSession = false;

  function sanitizeTagList(list) {
    if (list == null) return [];
    const arr = Array.isArray(list) ? list : [list];
    return Array.from(
      new Set(
        arr
          .map((tag) => normalizeTag(tag))
          .filter((tag) => tag.length > 0),
      ),
    );
  }

  function isTagHidden(tag) {
    const normalized = normalizeTag(tag);
    return normalized.length > 0 && hiddenTags.includes(normalized);
  }

  function getAllTagNames() {
    return [
      ...new Set(
        allPrompts
          .map((p) => normalizeTag(p.tag))
          .filter((tag) => tag.length > 0),
      ),
    ];
  }

  function getVisibleInAllCount() {
    return allPrompts.filter((item) => !isTagHidden(item.tag)).length;
  }

  async function loadHiddenTags() {
    if (!electronAPI?.getHiddenTags) return [];
    try {
      const stored = await electronAPI.getHiddenTags();
      return sanitizeTagList(stored);
    } catch (err) {
      console.error("加载隐藏分类失败", err);
      return [];
    }
  }

  async function persistHiddenTags(tags) {
    // 返回 boolean：失败时不改内存，避免界面以为已隐藏但磁盘仍旧。
    const sanitized = sanitizeTagList(tags);
    if (!electronAPI?.setHiddenTags) {
      hiddenTags = sanitized;
      return true;
    }
    try {
      const saved = await electronAPI.setHiddenTags(sanitized);
      hiddenTags = sanitizeTagList(saved);
      return true;
    } catch (err) {
      console.error("保存隐藏分类失败", err);
      showToast(`隐藏分类保存失败：${err?.message || err}`);
      return false;
    }
  }

  function setRenameTagError(message = "") {
    if (!renameTagError) return;
    renameTagError.textContent = message;
    renameTagError.style.visibility = message ? "visible" : "hidden";
  }

  function openRenameTagModal(tag) {
    if (!renameTagOverlay) return;
    renameTagOriginal = tag;
    if (renameTagInput) {
      renameTagInput.value = tag || "";
      setTimeout(() => {
        renameTagInput.focus();
        renameTagInput.select();
      }, 0);
    }
    setRenameTagError("");
    renameTagOverlay.style.display = "flex";
    syncBlurHideLock();
  }

  function closeRenameTagModal() {
    if (!renameTagOverlay) return;
    renameTagOverlay.style.display = "none";
    try { syncBlurHideLock(); } catch {}
    renameTagOriginal = null;
    setRenameTagError("");
  }

  async function handleRenameTagSave() {
    if (!renameTagOriginal) {
      closeRenameTagModal();
      return;
    }
    const normalizedOld = normalizeTag(renameTagOriginal);
    if (!normalizedOld) {
      closeRenameTagModal();
      return;
    }
    const newValue = renameTagInput?.value ?? "";
    const trimmed = newValue.trim();
    if (!trimmed) {
      setRenameTagError("分类名称不能为空");
      return;
    }
    const normalizedNew = normalizeTag(trimmed);

    if (normalizedNew === normalizedOld && trimmed === renameTagOriginal) {
      closeRenameTagModal();
      showToast("未做任何更改");
      return;
    }

    let changed = false;
    const updatedPrompts = allPrompts.map((prompt) => {
      if (normalizeTag(prompt.tag) === normalizedOld) {
        if (prompt.tag === trimmed) return prompt;
        changed = true;
        return { ...prompt, tag: trimmed };
      }
      return prompt;
    });

    if (!changed) {
      setRenameTagError("未找到需要更新的提示词或未做更改");
      return;
    }

    const previousPrompts = clonePromptList(allPrompts);
    const previousHidden = hiddenTags.slice();
    allPrompts = updatedPrompts;

    let hiddenChanged = false;
    let nextHidden = previousHidden;
    if (hiddenTags.includes(normalizedOld)) {
      nextHidden = hiddenTags.filter((tag) => tag !== normalizedOld);
      if (normalizedNew && !nextHidden.includes(normalizedNew)) {
        nextHidden.push(normalizedNew);
      }
      hiddenChanged = true;
      const okHidden = await persistHiddenTags(nextHidden);
      if (!okHidden) {
        allPrompts = previousPrompts;
        setRenameTagError("隐藏分类状态保存失败");
        showToast("重命名未能保存");
        return;
      }
    }

    const ok = await saveData();
    if (!ok) {
      allPrompts = previousPrompts;
      if (hiddenChanged) {
        await persistHiddenTags(previousHidden);
      }
      renderAll();
      setRenameTagError("保存失败，分类未改名");
      showToast("重命名未能保存");
      return;
    }
    closeRenameTagModal();
    showToast("分类已重命名");
  }

  // Context Menu Elements
  const contextMenu = document.getElementById("contextMenu");
  const contextPinText = document.getElementById("contextPinText");

  (async () => {
    const [prompts, storedHidden] = await Promise.all([
      loadPrompts(),
      loadHiddenTags(),
    ]);
    allPrompts = prompts;
    hiddenTags = storedHidden;
    renderAll();
    if (!allPrompts.length) {
      clearPreview();
    }
  })();

  async function refreshSafetyRestoreMenuLabel() {
    if (!menuSafetyRestore) return;
    const base = "恢复安全快照";
    try {
      if (!electronAPI?.listSafetySnapshots) {
        menuSafetyRestore.textContent = base;
        return;
      }
      const snaps = await electronAPI.listSafetySnapshots();
      const count = Array.isArray(snaps) ? snaps.length : 0;
      if (count <= 0) {
        menuSafetyRestore.textContent = `${base}（无）`;
        return;
      }
      const latest = snaps[0]?.at
        ? String(snaps[0].at).replace("T", " ").replace(/\.\d+Z$/, "")
        : "";
      menuSafetyRestore.textContent = latest
        ? `${base}（${count} · ${latest.slice(0, 16)}）`
        : `${base}（${count}）`;
    } catch {
      menuSafetyRestore.textContent = base;
    }
  }

  function isSystemMenuOpen() {
    return Boolean(moreMenu?.classList?.contains("is-open"));
  }

  function getSystemMenuAnchor() {
    // 侧栏收起时侧栏按钮不可点；优先顶栏「系统」。
    if (document.body.classList.contains("sidebar-collapsed") && headerSettingsBtn) {
      return headerSettingsBtn;
    }
    if (settingsBtn && settingsBtn.offsetParent !== null) return settingsBtn;
    return headerSettingsBtn || settingsBtn || null;
  }

  function positionSystemMenu(anchorEl = null) {
    if (!moreMenu) return;
    const pad = 8;
    const anchor = anchorEl || getSystemMenuAnchor();
    const rect = anchor?.getBoundingClientRect?.();
    const menuW = Math.max(moreMenu.offsetWidth || 200, 200);
    // 先放到屏内再量高度，避免首次 offsetHeight 为 0
    moreMenu.style.visibility = "hidden";
    moreMenu.classList.add("is-open");
    moreMenu.hidden = false;
    moreMenu.style.display = "block";
    const menuH = Math.max(moreMenu.offsetHeight || 320, 120);
    let left = Math.max(pad, window.innerWidth - menuW - 16);
    let top = 52;
    if (rect && Number.isFinite(rect.left)) {
      left = Math.min(
        window.innerWidth - menuW - pad,
        Math.max(pad, Math.round(rect.right - menuW)),
      );
      top = Math.round(rect.bottom + 6);
      if (top + menuH > window.innerHeight - pad) {
        top = Math.max(pad, Math.round(rect.top - menuH - 6));
      }
    }
    moreMenu.style.left = `${left}px`;
    moreMenu.style.top = `${top}px`;
    moreMenu.style.right = "auto";
    moreMenu.style.bottom = "auto";
    moreMenu.style.visibility = "";
  }

  function syncSystemMenuTriggers(open) {
    for (const btn of [settingsBtn, headerSettingsBtn]) {
      if (!btn) continue;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
  }

  function setSystemMenuOpen(open, anchorEl = null) {
    if (!moreMenu) return false;
    const next = open === true;
    if (next) {
      // 打开时刷新动态项，避免 ⌘, 与按钮点击表现不一致。
      void refreshSafetyRestoreMenuLabel();
      void refreshOpenAtLoginMenu();
      void refreshHotkeyMenu();
      // 与右键菜单一致：打开期间抑制失焦隐藏，避免点「系统」后窗口秒退。
      void pauseBlurHide(12000);
      positionSystemMenu(anchorEl);
    } else {
      moreMenu.classList.remove("is-open");
      moreMenu.hidden = true;
      moreMenu.style.display = "none";
      moreMenu.style.visibility = "";
    }
    syncSystemMenuTriggers(next);
    try { syncBlurHideLock(); } catch {}
    return next;
  }

  function toggleSystemMenu(anchorEl = null) {
    if (isSystemMenuOpen()) {
      return setSystemMenuOpen(false);
    }
    return setSystemMenuOpen(true, anchorEl);
  }

  if (settingsBtn) {
    settingsBtn.onclick = (e) => {
      e.stopPropagation();
      toggleSystemMenu(settingsBtn);
    };
  }
  if (headerSettingsBtn) {
    headerSettingsBtn.onclick = (e) => {
      e.stopPropagation();
      toggleSystemMenu(headerSettingsBtn);
    };
  }

  document.addEventListener("click", (e) => {
    if (!moreMenu || !isSystemMenuOpen()) return;
    if (e.target && moreMenu.contains(e.target)) return;
    if (settingsBtn && (e.target === settingsBtn || settingsBtn.contains(e.target))) return;
    if (headerSettingsBtn && (e.target === headerSettingsBtn || headerSettingsBtn.contains(e.target))) return;
    setSystemMenuOpen(false);
  });

  window.addEventListener("resize", () => {
    if (isSystemMenuOpen()) positionSystemMenu();
  });

  function buildWebdavSnapshot(config) {
    return {
      version: "1.0",
      webdavConfig: config,
    };
  }

  async function loadWebdavConfig() {
    if (!electronAPI?.getWebdavConfig) return null;
    const config = await electronAPI.getWebdavConfig();
    return config || null;
  }

  function collectWebdavConfig() {
    return {
      url: webdavUrl?.value?.trim() || "",
      username: webdavUsername?.value?.trim() || "",
      password: webdavPassword?.value || "",
      directory: webdavDir?.value?.trim() || "prompt-box-backups",
    };
  }

  async function saveWebdavConfig() {
    if (!electronAPI?.setWebdavConfig) return null;
    const config = collectWebdavConfig();
    try {
      await electronAPI.setWebdavConfig(config);
      return config;
    } catch (err) {
      console.error("保存 WebDAV 配置失败", err);
      showToast(`WebDAV 配置保存失败：${err?.message || err}`);
      return null;
    }
  }

  function renderWebdavBackups(list) {
    if (!webdavBackupList) return;
    webdavBackupList.innerHTML = "";
    if (webdavRestorePath) {
      webdavRestorePath.value = "";
    }
    if (!Array.isArray(list) || list.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "暂无备份";
      opt.disabled = true;
      opt.selected = true;
      webdavBackupList.appendChild(opt);
      return;
    }
    list.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item.path;
      const size = Number(item.size);
      const sizeText =
        Number.isFinite(size) && size >= 0
          ? `${(size / 1024).toFixed(size >= 1024 ? 1 : 0)} KB`
          : "未知大小";
      opt.textContent = `${item.name} ｜ ${item.lastMod || "未知时间"} ｜ ${sizeText}`;
      webdavBackupList.appendChild(opt);
    });
    webdavBackupList.selectedIndex = 0;
  }

  async function loadWebdavBackups() {
    if (!electronAPI?.listWebdavBackups) return;
    const list = await electronAPI.listWebdavBackups();
    renderWebdavBackups(list);
  }

  function openWebdavModal() {
    if (!webdavOverlay) return;
    webdavOverlay.style.display = "flex";
    syncBlurHideLock();
  }

  function closeWebdavModal() {
    if (!webdavOverlay) return;
    webdavOverlay.style.display = "none";
    try { syncBlurHideLock(); } catch {}
  }

  function openHiddenTagsModal() {
    if (!hiddenTagsOverlay) return;
    renderHiddenTagsList();
    hiddenTagsOverlay.style.display = "flex";
    syncBlurHideLock();
  }

  function closeHiddenTagsModal() {
    if (!hiddenTagsOverlay) return;
    hiddenTagsOverlay.style.display = "none";
    try { syncBlurHideLock(); } catch {}
  }

  function renderHiddenTagsList() {
    if (!hiddenTagsList || !hiddenTagsEmpty) return;
    const tags = getAllTagNames();
    hiddenTagsList.innerHTML = "";
    if (!tags.length) {
      hiddenTagsEmpty.style.display = "block";
      hiddenTagsList.style.display = "none";
      return;
    }
    hiddenTagsEmpty.style.display = "none";
    hiddenTagsList.style.display = "flex";
    tags.forEach((tag) => {
      const row = document.createElement("label");
      row.className = "hidden-tag-row";
      const left = document.createElement("div");
      left.className = "hidden-tag-row-left";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = tag;
      checkbox.checked = hiddenTags.includes(tag);
      const span = document.createElement("span");
      span.textContent = tag;
      left.appendChild(checkbox);
      left.appendChild(span);
      const hint = document.createElement("small");
      hint.textContent = checkbox.checked
        ? "已从“全部提示词”隐藏"
        : "显示在“全部提示词”";
      checkbox.onchange = () => {
        hint.textContent = checkbox.checked
          ? "已从“全部提示词”隐藏"
          : "显示在“全部提示词”";
      };
      row.appendChild(left);
      row.appendChild(hint);
      hiddenTagsList.appendChild(row);
    });
  }

  async function saveHiddenTagsSelection() {
    if (!hiddenTagsList) return;
    const checkboxes = hiddenTagsList.querySelectorAll('input[type="checkbox"]');
    const selected = Array.from(checkboxes)
      .filter((cb) => cb.checked)
      .map((cb) => cb.value);
    const ok = await persistHiddenTags(selected);
    if (!ok) {
      // 保持弹层打开，方便用户重试；内存未改。
      renderHiddenTagsList();
      return;
    }
    closeHiddenTagsModal();
    renderAll();
    showToast("隐藏分类设置已更新");
  }

  function hideToast() {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.style.opacity = "0";
    if (toastClearTimer) clearTimeout(toastClearTimer);
    toastClearTimer = setTimeout(() => {
      toast.style.display = "none";
      toast.innerHTML = "";
      toastClearTimer = null;
    }, 220);
  }

  function showToast(message = "", options = {}) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    const {
      actionLabel = "",
      onAction = null,
      duration = actionLabel ? 5600 : 1600,
    } = options || {};

    if (toastHideTimer) {
      clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
    if (toastClearTimer) {
      clearTimeout(toastClearTimer);
      toastClearTimer = null;
    }

    toast.innerHTML = "";
    const textEl = document.createElement("span");
    textEl.className = "toast-text";
    textEl.textContent = String(message || "");
    toast.appendChild(textEl);

    if (actionLabel && typeof onAction === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = actionLabel;
      btn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideToast();
        Promise.resolve(onAction()).catch((err) => {
          console.error("toast action failed", err);
        });
      };
      toast.appendChild(btn);
    }

    toast.style.display = "flex";
    toast.style.opacity = "1";
    // 带撤销的 toast 需要人点一下：期间抑制失焦隐藏，避免 toast 连同撤销入口一起消失。
    if (actionLabel && typeof onAction === "function") {
      void pauseBlurHide(Math.max(Number(duration) || 0, 3000) + 500);
    }
    toastHideTimer = setTimeout(() => {
      hideToast();
      toastHideTimer = null;
    }, duration);
  }

  async function notifyUser(
    message,
    { system = false, title = "PromptBox", silent = false } = {},
  ) {
    const text = String(message || "").trim();
    if (!text) return;
    // 使用成功后窗口通常已隐藏：优先系统通知，避免无效 toast。
    if (system) {
      try {
        if (electronAPI?.showNotification) {
          const ok = await electronAPI.showNotification({
            title,
            body: text,
            silent: silent === true,
          });
          if (ok) return;
        }
      } catch (err) {
        console.error("系统通知失败", err);
      }
    }
    showToast(text);
  }

  function clearPendingUndo() {
    pendingUndo = null;
  }

  async function applyPendingUndo() {
    if (!pendingUndo) return false;
    const undo = pendingUndo;
    pendingUndo = null;

    if (undo.type === "delete") {
      const index = Math.max(0, Math.min(Number(undo.index) || 0, allPrompts.length));
      const item = normalizePrompt(undo.item);
      if (!item) return false;
      const previous = clonePromptList(allPrompts);
      const previousSelected = selectedIndex;
      allPrompts.splice(index, 0, item);
      selectedIndex = index;
      const ok = await saveData();
      if (!ok) {
        allPrompts = previous;
        selectedIndex = previousSelected;
        pendingUndo = undo;
        renderAll();
        showToast("撤销未能保存，可再试一次");
        return false;
      }
      showToast("已撤销删除");
      return true;
    }

    if (undo.type === "replace") {
      const previous = clonePromptList(allPrompts);
      allPrompts = clonePromptList(undo.prompts);
      selectedIndex = null;
      const ok = await saveData();
      if (!ok) {
        allPrompts = previous;
        pendingUndo = undo;
        renderAll();
        showToast("撤销未能保存，可再试一次");
        return false;
      }
      showToast(`已恢复替换前数据（${allPrompts.length} 条）`);
      return true;
    }

    return false;
  }

  async function togglePinAtIndex(index) {
    const item = allPrompts[index];
    if (!item) return false;
    const prev = item.isPinned === true;
    item.isPinned = !prev;
    const ok = await saveData();
    if (!ok) {
      item.isPinned = prev;
      renderAll();
      showToast("置顶状态未能保存");
      return false;
    }
    showToast(item.isPinned ? "已置顶" : "已取消置顶");
    return true;
  }

  async function copyPromptContentAtIndex(index) {
    const item = allPrompts[index];
    if (!item) return false;
    const ok = await copyText(item.content || "");
    if (!ok) {
      showToast("复制失败");
      return false;
    }
    // 复制成功不 toast：用户仍在窗口内，剪贴板结果可直观验证。
    return true;
  }

  function nextDuplicateName(baseName) {
    const root = String(baseName || "未命名").trim() || "未命名";
    const existing = new Set(allPrompts.map((p) => String(p?.name || "").trim()));
    let candidate = `${root} 副本`;
    if (!existing.has(candidate)) return candidate;
    let n = 2;
    while (existing.has(`${root} 副本 ${n}`)) n += 1;
    return `${root} 副本 ${n}`;
  }

  async function duplicatePromptAtIndex(index) {
    const item = allPrompts[index];
    if (!item) return false;
    const cloned = normalizePrompt({
      ...item,
      name: nextDuplicateName(item.name),
      isPinned: false,
      useCount: 0,
      lastUsedAt: "",
    });
    if (!cloned) {
      showToast("创建副本失败");
      return false;
    }
    const previousSelected = selectedIndex;
    const insertAt = Math.min(index + 1, allPrompts.length);
    allPrompts.splice(insertAt, 0, cloned);
    selectedIndex = insertAt;
    clearPendingUndo();
    const ok = await saveData();
    if (!ok) {
      allPrompts.splice(insertAt, 1);
      selectedIndex = previousSelected;
      renderAll();
      if (selectedIndex !== null && allPrompts[selectedIndex]) {
        selectCard(selectedIndex, false, { instant: true });
      }
      showToast("创建副本未能保存");
      return false;
    }
    showToast("已创建副本");
    return true;
  }

  async function sharePromptAtIndex(index, format = "markdown") {
    const item = allPrompts[index];
    if (!item) return false;
    const payload = formatPromptShareText(item, format);
    if (!payload) {
      showToast("分享失败：内容无效");
      return false;
    }
    const ok = await copyText(payload);
    if (!ok) {
      showToast("分享失败：无法写入剪贴板");
      return false;
    }
    // 分享成功不 toast：仍停在管理层，失败才提示。
    return true;
  }

  async function deletePromptAtIndex(index, { confirmMessage = false } = {}) {
    if (!Number.isInteger(index) || index < 0 || !allPrompts[index]) return false;
    const item = allPrompts[index];
    // 默认软删除 + toast 撤销；需要二次确认时再弹（避免 confirm 触发失焦隐藏）。
    if (confirmMessage) {
      if (!(await safeConfirm(`确定删除 "${item.name}" 吗？`))) return false;
    }
    const previousSelected = selectedIndex;
    const removed = allPrompts.splice(index, 1)[0];
    if (selectedIndex === index) {
      // 删除后落到相邻项，保持键盘管理连续手感。
      selectedIndex = allPrompts.length
        ? Math.min(index, allPrompts.length - 1)
        : null;
    } else if (selectedIndex !== null && selectedIndex > index) {
      selectedIndex -= 1;
    }

    pendingUndo = {
      type: "delete",
      index,
      item: { ...removed },
    };
    const ok = await saveData();
    if (!ok) {
      // 磁盘未写入：回滚内存，避免重启后“删了又回来”的错觉。
      allPrompts.splice(index, 0, removed);
      selectedIndex = previousSelected;
      pendingUndo = null;
      renderAll();
      if (selectedIndex !== null && allPrompts[selectedIndex]) {
        selectCard(selectedIndex, false, { instant: true });
      }
      showToast("删除未能保存，已恢复该项");
      return false;
    }
    if (selectedIndex !== null && allPrompts[selectedIndex]) {
      selectCard(selectedIndex, false, { instant: true });
    }
    showToast("已删除，可撤销", {
      actionLabel: "撤销",
      onAction: () => applyPendingUndo(),
    });
    return true;
  }

  async function closeCurrentWindowSilently() {
    try {
      assertElectron();
      await electronAPI.minimizeWindow();
    } catch {
      showToast("隐藏失败，请检查快捷键/权限设置");
    }
  }

  // Context Menu Functions
  function showContextMenu(e, item) {
    if (!contextMenu) return;
    // 右键管理时抑制失焦隐藏，避免菜单刚出来窗口就退场。
    void pauseBlurHide(12000);
    contextMenuTargetIndex = item.originalIndex;

    // 更新置顶按钮文字
    if (contextPinText) {
      contextPinText.textContent = item.isPinned ? "取消置顶" : "置顶";
    }

    // 先显示再量尺寸，把菜单夹进可视区，避免贴边点右键时菜单出屏。
    contextMenu.style.visibility = "hidden";
    contextMenu.style.display = "block";
    const pad = 8;
    const menuW = Math.max(contextMenu.offsetWidth || 200, 180);
    const menuH = Math.max(contextMenu.offsetHeight || 260, 160);
    let x = Number(e?.clientX) || 0;
    let y = Number(e?.clientY) || 0;
    x = Math.min(Math.max(pad, x), Math.max(pad, window.innerWidth - menuW - pad));
    y = Math.min(Math.max(pad, y), Math.max(pad, window.innerHeight - menuH - pad));
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.style.visibility = "";
    try { syncBlurHideLock(); } catch {}
  }

  function hideContextMenu() {
    if (contextMenu) {
      contextMenu.style.display = "none";
    }
    contextMenuTargetIndex = null;
    try { syncBlurHideLock(); } catch {}
  }

  // 点击其他地方关闭右键菜单
  document.addEventListener("click", (e) => {
    if (contextMenu && !contextMenu.contains(e.target)) {
      hideContextMenu();
    }
  });

  // 右键菜单项点击处理
  if (contextMenu) {
    contextMenu.querySelectorAll(".context-menu-item").forEach((item) => {
      item.onclick = async () => {
        const action = item.dataset.action;
        const index = contextMenuTargetIndex;
        if (index === null) return;

        const data = allPrompts[index];
        if (!data) return;

        switch (action) {
          case "pin":
            // 与快捷键/预览共用 togglePinAtIndex，含落盘失败回滚。
            await togglePinAtIndex(index);
            break;
          case "edit":
            openEditModal(index);
            break;
          case "copy":
            await copyPromptContentAtIndex(index);
            break;
          case "duplicate":
            await duplicatePromptAtIndex(index);
            break;
          case "share":
            await sharePromptAtIndex(index, "markdown");
            break;
          case "share-json":
            await sharePromptAtIndex(index, "json");
            break;
          case "delete":
            await deletePromptAtIndex(index);
            break;
        }
        hideContextMenu();
      };
    });
  }

  function renderAll() {
    updateSidebarAndDropdown();
    renderCards();
    if (hiddenTagsOverlay && hiddenTagsOverlay.style.display === "flex") {
      renderHiddenTagsList();
    }
    needsListRefresh = false;
  }

  function focusModalPrimaryField() {
    const nameInput = document.getElementById("newName");
    if (!nameInput) return;
    requestAnimationFrame(() => {
      nameInput.focus();
      nameInput.select();
    });
  }

  function openEditModal(index) {
    const data = allPrompts[index];
    if (!data) return;
    // 已有未保存草稿时不切换条目/重置表单，避免管理动作冲掉编辑。
    if (isDirtyPromptModalOpen()) {
      if (editingIndex === index) {
        try { focusModalPrimaryField(); } catch {}
        return;
      }
      showToast("有未保存的编辑，请先保存或关闭", { duration: 2200 });
      try { focusModalPrimaryField(); } catch {}
      return;
    }
    editingIndex = index;
    selectCard(index);
    const nameInput = document.getElementById("newName");
    const contentInput = document.getElementById("newContent");
    if (nameInput) nameInput.value = data.name;
    if (tagInput) tagInput.value = data.tag;
    if (contentInput) contentInput.value = data.content;
    if (modalTitle) modalTitle.innerText = "编辑提示词";
    discardFormArmedUntil = 0;
    if (modal) modal.style.display = "flex";
    syncBlurHideLock();
    focusModalPrimaryField();
  }

  function applyPreviewTheme(item, options = {}) {
    if (!previewPanel) return;
    const animate = options.animate !== false;
    const base = item
      ? `${item.name || ""}|${normalizeTag(item.tag) || ""}`
      : "default";
    let hash = 0;
    for (let i = 0; i < base.length; i += 1) {
      hash = (hash * 31 + base.charCodeAt(i)) % 360;
    }
    const hue = (hash + 220) % 360;
    previewPanel.style.setProperty("--preview-hue", hue);
    if (!animate) {
      previewPanel.classList.remove("preview-change");
      return;
    }
    previewPanel.classList.remove("preview-change");
    // Avoid forced reflow; use double-rAF only when animation is requested.
    requestAnimationFrame(() => {
      if (!previewPanel) return;
      previewPanel.classList.remove("preview-change");
      requestAnimationFrame(() => {
        if (previewPanel) previewPanel.classList.add("preview-change");
      });
    });
  }

  function clearPreview() {
    selectedIndex = null;
    setActiveCardElement(null);
    if (previewTitle) previewTitle.textContent = "选择一条提示词";
    if (previewBody) {
      previewBody.textContent =
        "单击立即使用，Shift+单击仅复制；直接打字搜索；右键或 E/P/Delete(⌫) 管理。";
    }
    if (previewUsageStats) {
      previewUsageStats.textContent = "暂无使用记录";
    }
    if (previewUse) previewUse.disabled = true;
    if (previewShare) previewShare.disabled = true;
    if (previewPin) {
      setPreviewActionButtonLabel(previewPin, "置顶", "(P)");
      previewPin.disabled = true;
    }
    if (previewEdit) previewEdit.disabled = true;
    if (previewDelete) previewDelete.disabled = true;
    if (previewPanel) previewPanel.style.opacity = "0.9";
    applyPreviewTheme(null);
  }

  function updatePreview(item, options = {}) {
    if (!item) return;
    const animate = options.animate !== false;
    const { useText, lastUsedText } = getUsageSummary(item);
    if (previewTitle) previewTitle.textContent = item.name || "未命名";
    if (previewBody) previewBody.textContent = item.content || "";
    if (previewUsageStats) {
      previewUsageStats.textContent = `${useText} · ${lastUsedText}`;
    }
    if (previewUse) previewUse.disabled = false;
    if (previewShare) previewShare.disabled = false;
    if (previewPin) {
      setPreviewActionButtonLabel(previewPin, item.isPinned ? "取消置顶" : "置顶", "(P)");
      previewPin.disabled = false;
    }
    if (previewEdit) {
      previewEdit.disabled = false;
      previewEdit.title = "编辑 (E，空搜索时)";
    }
    if (previewDelete) {
      previewDelete.disabled = false;
      previewDelete.title = "删除 (Delete/⌫，可撤销)";
    }
    if (previewUse) {
      previewUse.disabled = false;
      previewUse.title = "立即使用（Shift 仅复制）";
    }
    if (previewPanel) previewPanel.style.opacity = "1";
    applyPreviewTheme(item, { animate });
  }

  let previewUpdateFrame = 0;
  let lastActiveCardEl = null;
  let keyboardNavUntil = 0;

  function markKeyboardNavigation() {
    keyboardNavUntil = performance.now() + 280;
  }

  function isKeyboardNavigating() {
    return performance.now() < keyboardNavUntil;
  }

  // 唤起时窗口常出现在光标下；未移动指针前忽略 mouseenter，避免抢走默认第一名。
  let pointerHoverSelectEnabled = true;
  let pointerHoverArmTimer = 0;
  let pointerHoverArmCleanup = null;
  function armPointerHoverSelectAfterMove() {
    // 唤起常在光标下：未发生有意移动前忽略悬停改选，保住默认第一名。
    pointerHoverSelectEnabled = false;
    if (typeof pointerHoverArmCleanup === "function") {
      pointerHoverArmCleanup();
      pointerHoverArmCleanup = null;
    }
    if (pointerHoverArmTimer) {
      clearTimeout(pointerHoverArmTimer);
      pointerHoverArmTimer = 0;
    }
    let originX = null;
    let originY = null;
    const selectCardUnderPoint = (clientX, clientY) => {
      if (isKeyboardNavigating()) return;
      const el =
        typeof document.elementFromPoint === "function"
          ? document.elementFromPoint(clientX, clientY)
          : null;
      const card = el && typeof el.closest === "function" ? el.closest(".card") : null;
      if (!card) return;
      const index = Number(card.dataset.originalIndex);
      if (!Number.isFinite(index)) return;
      selectCard(index, true, { animate: false });
    };
    const onMove = (e) => {
      if (originX === null) {
        originX = e.clientX;
        originY = e.clientY;
        return;
      }
      if (Math.abs(e.clientX - originX) + Math.abs(e.clientY - originY) >= 6) {
        pointerHoverSelectEnabled = true;
        // 有意移动后立刻对准光标下卡片（不必再 leave/re-enter 才触发 mouseenter）。
        selectCardUnderPoint(e.clientX, e.clientY);
        cleanup();
      }
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove, true);
      if (pointerHoverArmCleanup === cleanup) pointerHoverArmCleanup = null;
    };
    pointerHoverArmCleanup = cleanup;
    window.addEventListener("mousemove", onMove, true);
    // 超时只解锁悬停；未移动则仍保持第一名，直到真正 mouseenter。
    pointerHoverArmTimer = window.setTimeout(() => {
      pointerHoverSelectEnabled = true;
      cleanup();
      pointerHoverArmTimer = 0;
    }, 2000);
  }

  function setActiveCardElement(nextCard) {
    if (lastActiveCardEl && lastActiveCardEl !== nextCard && lastActiveCardEl.isConnected) {
      lastActiveCardEl.classList.remove("active-card");
      lastActiveCardEl.setAttribute("aria-selected", "false");
    }
    const scope = cardGrid || document;
    scope.querySelectorAll(".card.active-card").forEach((el) => {
      if (el !== nextCard) {
        el.classList.remove("active-card");
        el.setAttribute("aria-selected", "false");
      }
    });
    if (nextCard) {
      nextCard.classList.add("active-card");
      nextCard.setAttribute("aria-selected", "true");
    }
    lastActiveCardEl = nextCard || null;
  }

  function schedulePreviewUpdate(item, { animate = true } = {}) {
    if (previewUpdateFrame) {
      cancelAnimationFrame(previewUpdateFrame);
      previewUpdateFrame = 0;
    }
    previewUpdateFrame = requestAnimationFrame(() => {
      previewUpdateFrame = 0;
      updatePreview(item, { animate });
    });
  }

  function selectCard(originalIndex, fromHover = false, options = {}) {
    if (!Number.isInteger(originalIndex) || originalIndex < 0 || !allPrompts[originalIndex]) {
      if (selectedIndex !== null) {
        selectedIndex = null;
        setActiveCardElement(null);
        if (previewTitle) previewTitle.textContent = "选择一条提示词";
        if (previewBody) {
          previewBody.textContent =
            "单击立即使用，Shift+单击仅复制；直接打字搜索；右键或 E/P/Delete(⌫) 管理。";
        }
        if (previewUsageStats) previewUsageStats.textContent = "暂无使用记录";
        if (previewUse) previewUse.disabled = true;
        if (previewShare) previewShare.disabled = true;
        if (previewPin) {
          setPreviewActionButtonLabel(previewPin, "置顶", "(P)");
          previewPin.disabled = true;
        }
        if (previewEdit) previewEdit.disabled = true;
        if (previewDelete) previewDelete.disabled = true;
      }
      return;
    }
    if (selectedIndex === originalIndex && fromHover) return;
    selectedIndex = originalIndex;
    const nextCard =
      (cardGrid && cardGrid.querySelector(`.card[data-original-index="${originalIndex}"]`)) ||
      document.querySelector(`.card[data-original-index="${originalIndex}"]`) ||
      null;
    setActiveCardElement(nextCard);
    const item = allPrompts[originalIndex];
    const animate = options.animate !== false && !options.instant;
    if (options.instant) {
      updatePreview(item, { animate: false });
    } else {
      schedulePreviewUpdate(item, { animate });
    }
  }

  function ensureCardVisible(card) {
    if (!card || !cardGrid) return;
    const scroller = cardGrid;
    const scrollerRect = scroller.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const pad = 12;
    const offsetTop = cardRect.top - scrollerRect.top;
    const offsetBottom = cardRect.bottom - scrollerRect.top;

    if (offsetTop < pad) {
      scroller.scrollTop += offsetTop - pad;
    } else if (offsetBottom > scroller.clientHeight - pad) {
      scroller.scrollTop += offsetBottom - (scroller.clientHeight - pad);
    }
  }

  function selectFirstVisibleForCall() {
    // 干净调用态：默认选中可见第一名，Enter 与数字键 1 肌肉记忆一致。
    if (cardGrid) cardGrid.scrollTop = 0;
    const cards = getVisibleCards();
    if (!cards.length) return false;
    const first = cards[0];
    const index = Number(first.dataset.originalIndex);
    if (!Number.isFinite(index)) return false;
    selectCard(index, false, { instant: true });
    ensureCardVisible(first);
    return true;
  }

  function getVisibleCards() {
    if (!cardGrid) return [];
    return Array.from(cardGrid.querySelectorAll(".card"));
  }

  function getVisiblePromptIndices() {
    return getVisibleCards()
      .map((card) => Number(card.dataset.originalIndex))
      .filter((index) => Number.isInteger(index) && index >= 0);
  }

  function focusCardForCall(card) {
    if (!card) return false;
    markKeyboardNavigation();
    card.focus({ preventScroll: true });
    const index = Number(card.dataset.originalIndex);
    if (Number.isFinite(index)) {
      selectCard(index, false, { instant: true });
    }
    ensureCardVisible(card);
    return true;
  }

  function focusSelectedOrFirstCard() {
    const cards = getVisibleCards();
    if (!cards.length) return false;
    let target = null;
    if (selectedIndex !== null) {
      target =
        cards.find((card) => Number(card.dataset.originalIndex) === selectedIndex) ||
        null;
    }
    return focusCardForCall(target || cards[0]);
  }

  async function useVisiblePromptByRank(rank, options = {}) {
    // rank is 1-based among currently visible cards
    if (useInFlight) return false;
    const cards = getVisibleCards();
    if (rank < 1 || rank > cards.length) return false;
    const card = cards[rank - 1];
    const index = Number(card.dataset.originalIndex);
    if (!Number.isInteger(index)) return false;
    markKeyboardNavigation();
    card.focus({ preventScroll: true });
    selectCard(index, false, { instant: true });
    ensureCardVisible(card);
    const result = await usePromptAtIndex(index, card, options);
    return Boolean(result);
  }

  function focusAdjacentCard(step) {
    const cards = getVisibleCards();
    if (cards.length === 0) return false;

    const activeCard = document.activeElement?.closest?.(".card") || null;
    let currentIndex = activeCard ? cards.indexOf(activeCard) : -1;

    if (currentIndex === -1 && selectedIndex !== null) {
      currentIndex = cards.findIndex(
        (card) => Number(card.dataset.originalIndex) === selectedIndex,
      );
    }

    let nextIndex;
    if (currentIndex === -1) {
      nextIndex = step > 0 ? 0 : cards.length - 1;
    } else {
      nextIndex = (currentIndex + step + cards.length) % cards.length;
    }

    const nextCard = cards[nextIndex];
    if (!nextCard) return false;

    markKeyboardNavigation();
    nextCard.focus({ preventScroll: true });
    selectCard(Number(nextCard.dataset.originalIndex), false, { instant: true });
    ensureCardVisible(nextCard);
    return true;
  }

  function closeAllBlockingLayers({ preserveDirtyPrompt = true } = {}) {
    // 再次唤起时回到干净调用态，不把上次未关的弹层带回来。
    // 未保存编辑草稿默认保留：托盘/二次启动/focus-search 不得静默 resetForm。
    try { hideContextMenu(); } catch {}
    try { setSystemMenuOpen(false); } catch {}
    if (modal && modal.style.display === "flex") {
      if (preserveDirtyPrompt && typeof isPromptFormDirty === "function" && isPromptFormDirty()) {
        // keep open
      } else {
        modal.style.display = "none";
        try { resetForm(); } catch {}
      }
    } else if (modal) {
      modal.style.display = "none";
      try { resetForm(); } catch {}
    }
    try { closePasteConfigModal(); } catch {}
    try { closeCopyConfigModal(); } catch {}
    try { closeRenameTagModal(); } catch {}
    try { closeHiddenTagsModal(); } catch {}
    try { closeWebdavModal(); } catch {}
    try { syncBlurHideLock(); } catch {}
  }

  function isDirtyPromptModalOpen() {
    return (
      modal &&
      modal.style.display === "flex" &&
      typeof isPromptFormDirty === "function" &&
      isPromptFormDirty()
    );
  }

  function isModalLayerOpen() {
    // 真正挡住调用主路径的层（编辑/同步/右键等）
    return (
      contextMenu?.style.display === "block" ||
      modal?.style.display === "flex" ||
      pasteConfigOverlay?.style.display === "flex" ||
      copyConfigOverlay?.style.display === "flex" ||
      renameTagOverlay?.style.display === "flex" ||
      hiddenTagsOverlay?.style.display === "flex" ||
      webdavOverlay?.style.display === "flex"
    );
  }

  function isBlockingLayerOpen() {
    // 含系统菜单：管理类快捷键默认仍回避，避免误触。
    return isModalLayerOpen() || isSystemMenuOpen();
  }

  function syncBlurHideLock() {
    // 管理弹层/系统菜单打开时锁定失焦隐藏，关掉后立刻恢复启动器“点外面就退”。
    const locked = isModalLayerOpen() || isSystemMenuOpen();
    try {
      if (electronAPI?.setBlurHideLocked) {
        void electronAPI.setBlurHideLocked(locked);
      } else if (locked) {
        void pauseBlurHide(15000);
      }
    } catch {}
    return locked;
  }


  function dismissSystemMenuForCallPath() {
    if (isSystemMenuOpen()) setSystemMenuOpen(false);
  }

  function flashCard(card, className = "card-using") {
    if (!card || !card.classList) return;
    card.classList.remove("card-using", "card-copy-only");
    card.classList.add(className);
    window.setTimeout(() => {
      if (card.isConnected) card.classList.remove(className);
    }, 220);
  }

  function setUseInFlight(next) {
    useInFlight = next === true;
    // 使用进行中锁住列表点击/预览主按钮，避免连点触发第二次粘贴。
    try {
      document.body.classList.toggle("call-use-in-flight", useInFlight);
    } catch {}
  }

  async function usePromptAtIndex(index, card = null, options = {}) {
    if (useInFlight) return null;
    const item = allPrompts[index];
    if (!item) return null;
    const paste = options?.paste !== false;

    setUseInFlight(true);
    if (previewUse) previewUse.disabled = true;
    try {
      // Shift 使用：只复制到剪贴板，不自动粘贴、不强制隐藏，方便连续取用。
      if (!paste) {
        const copied = await copyText(item.content || "");
        if (!copied) {
          showToast("复制失败，请手动复制");
          return { copied: false, pasted: false, copyOnly: true };
        }
        markPromptUsed(item);
        selectedIndex = index;
        await saveData({ render: false });
        // 仅复制成功：轻闪卡片即可，不弹 toast 打断连续取用。
        flashCard(card, "card-copy-only");
        return { copied: true, pasted: false, copyOnly: true };
      }

      flashCard(card, "card-using");
      const result = await copyPromptForUse(item.content);
      if (!result?.copied) {
        console.error("复制失败");
        showToast("复制失败，请手动复制");
        return result;
      }

      markPromptUsed(item);
      selectedIndex = index;
      if (result.pasted) {
        // 成功粘贴后异步串行静默保存：不挡 useInFlight，且连点不互相覆盖。
        queueSilentSave();
        // 调用层成功路径保持静默：已回到原应用，不弹通知打扰工作流。
        return result;
      }

      // 失败回退路径仍同步保存，保证使用统计与内存一致后再提示。
      await saveData({ render: false });

      if (result.requiresAccessibilityPermission) {
        await notifyUser(`未自动粘贴：需辅助功能权限（可 ⌘V）`, { system: true });
        // 每个会话只自动打开一次设置，避免连续调用被系统设置页抢走焦点。
        if (!a11ySettingsOpenedThisSession) {
          a11ySettingsOpenedThisSession = true;
          void openAccessibilitySettings();
        }
        closeCurrentWindowSilently();
      } else if (result.requiresAutomationPermission) {
        await notifyUser(`未自动粘贴：需自动化权限（可 ⌘V）`, { system: true });
        if (!automationSettingsOpenedThisSession) {
          automationSettingsOpenedThisSession = true;
          void openAutomationSettings();
        }
        closeCurrentWindowSilently();
      } else {
        await notifyUser(`未自动粘贴：内容已在剪贴板，可 ⌘V`, { system: true });
        closeCurrentWindowSilently();
      }

      // 成功粘贴后窗口已隐藏，无需再选中；失败回退路径若窗口仍在，再对齐选中态。
      if (!result.pasted && allPrompts[index]) {
        selectCard(index, false, { instant: true });
      }
      return result;
    } finally {
      setUseInFlight(false);
      if (previewUse) {
        previewUse.disabled = !(selectedIndex !== null && allPrompts[selectedIndex]);
      }
    }
  }

  function updateSidebarAndDropdown() {
    const tags = getAllTagNames();

    if (tags.length === 0) {
      tagDropdown.innerHTML = '<div class="tag-dropdown-empty">暂无已有标签</div>';
    } else {
      tagDropdown.innerHTML = tags
        .map(
          (tag) => `
                <div class="tag-option">
                    ${escapeHtml(tag)}
                </div>
            `,
        )
        .join("");
    }

    tagDropdown.querySelectorAll(".tag-option").forEach((option) => {
      option.onmousedown = () => {
        tagInput.value = option.innerText.trim();
        tagDropdown.style.display = "none";
      };
    });

    const currentFilter =
      document.querySelector(".nav-item.active")?.dataset.filter || "all";
    const existingLinks = navItemsContainer.querySelectorAll("a.nav-item");
    existingLinks.forEach((link) => link.remove());

    const allLink = createNavLink(
      "all",
      "全部提示词",
      getVisibleInAllCount(),
      currentFilter === "all",
    );
    navItemsContainer.insertBefore(allLink, document.getElementById("addTagBtn"));

    tags.forEach((tag) => {
      const count = allPrompts.filter((p) => normalizeTag(p.tag) === tag).length;
      const tagLink = createNavLink(tag, tag, count, currentFilter === tag, {
        hidden: hiddenTags.includes(tag),
      });
      navItemsContainer.insertBefore(tagLink, document.getElementById("addTagBtn"));
    });

    document.querySelectorAll(".nav-item").forEach((item) => {
      item.onclick = (e) => {
        e.preventDefault();
        document.querySelectorAll(".nav-item").forEach((nav) => {
          nav.classList.remove("active");
          nav.setAttribute("aria-pressed", "false");
        });
        item.classList.add("active");
        item.setAttribute("aria-pressed", "true");
        renderCards();
      };
      item.oncontextmenu = (e) => {
        const targetFilter = item.dataset.filter;
        if (!targetFilter || targetFilter === "all") return;
        e.preventDefault();
        openRenameTagModal(targetFilter);
      };
    });
  }

  function createNavLink(filter, text, count, isActive, options = {}) {
    const { hidden = false } = options;
    const a = document.createElement("a");
    a.href = "#";
    a.className = `nav-item ${isActive ? "active" : ""}`;
    a.dataset.filter = filter;
    a.setAttribute("role", "button");
    a.setAttribute("aria-pressed", isActive ? "true" : "false");
    a.setAttribute("aria-label", `${text}，${count} 条`);
    const label = document.createElement("span");
    label.className = "nav-item-label";
    label.textContent = text;
    if (hidden && filter !== "all") {
      const flag = document.createElement("span");
      flag.className = "nav-hidden-flag";
      flag.textContent = "隐藏";
      label.appendChild(flag);
    }
    const countBadge = document.createElement("span");
    countBadge.className = "nav-count-badge";
    countBadge.textContent = count;
    a.appendChild(label);
    a.appendChild(countBadge);
    return a;
  }

  async function saveData(options = {}) {
    const { render = true } = options || {};
    // 串行落盘：粘贴成功静默保存与删除/导入/编辑保存共用同一队列。
    // 返回 boolean：调用方在删除/保存表单等路径可按失败回滚，避免“界面已删磁盘还在”。
    const run = async () => {
      allPrompts = sanitizePromptList(allPrompts);
      let ok = true;
      try {
        await persistPrompts(allPrompts);
      } catch (err) {
        ok = false;
        console.error("保存失败", err);
        showToast(`保存失败：${err?.message || err}`);
      }
      if (render) {
        renderAll();
        needsListRefresh = false;
      } else {
        needsListRefresh = true;
      }
      return ok;
    };
    const queued = saveChain.then(run, run);
    // 队列本身不因单次失败断开；调用方仍能拿到 false。
    saveChain = queued.then(
      () => {},
      (err) => {
        console.error("保存队列失败", err);
      },
    );
    return queued;
  }

  function queueSilentSave() {
    // 先同步标脏：异步落盘未完成时再次唤起也会重排。
    needsListRefresh = true;
    return saveData({ render: false });
  }

  async function flushPendingSaves() {
    // 退出前等待串行落盘完成，避免粘贴统计/删除结果丢在半路上。
    try {
      await saveChain;
    } catch (err) {
      console.error("flushPendingSaves wait failed", err);
    }
  }

  function renderCards() {
    const term = searchInput.value.toLowerCase().trim();
    const activeFilter =
      document.querySelector(".nav-item.active")?.dataset.filter || "all";

    cardGrid.innerHTML = "";
    let visibleCount = 0;
    const visibleIndices = [];
    const displayList = [...allPrompts].map((item, originalIndex) => ({
      ...item,
      originalIndex,
    }));
    const matchedItems = [];
    const isSearching = term.length > 0;

    const createSection = (title, note = "") => {
      const section = document.createElement("section");
      section.className = "card-section";
      const header = document.createElement("div");
      header.className = "card-section-header";
      const titleEl = document.createElement("div");
      titleEl.className = "card-section-title";
      titleEl.textContent = title;
      header.appendChild(titleEl);
      if (note) {
        const noteEl = document.createElement("div");
        noteEl.className = "card-section-note";
        noteEl.textContent = note;
        header.appendChild(noteEl);
      }
      const list = document.createElement("div");
      list.className = "card-section-list";
      section.appendChild(header);
      section.appendChild(list);
      cardGrid.appendChild(section);
      return list;
    };

    const createCard = (item) => {
      const normalizedTag = normalizeTag(item.tag);
      const card = document.createElement("div");
      card.className = "card";
      const { useText, lastUsedText } = getUsageSummary(item);
      if (item.isPinned) {
        card.classList.add("pinned-card");
      }
      if (selectedIndex === item.originalIndex) {
        card.classList.add("active-card");
      }

      card.tabIndex = 0;
      card.dataset.originalIndex = item.originalIndex;
      card.setAttribute("role", "option");
      card.setAttribute("aria-selected", selectedIndex === item.originalIndex ? "true" : "false");
      card.setAttribute("aria-label", `${item.name || "未命名"}，${normalizedTag || "默认"}`);
      card.addEventListener("mouseenter", () => {
        if (isKeyboardNavigating()) return;
        // 唤起后指针未移动前不悬停改选，保住第一名肌肉记忆。
        if (!pointerHoverSelectEnabled) return;
        selectCard(item.originalIndex, true, { animate: false });
      });
      card.addEventListener("focus", () => {
        selectCard(item.originalIndex, true, { animate: false });
      });
      card.addEventListener("click", async (e) => {
        dismissSystemMenuForCallPath();
        selectCard(item.originalIndex);
        card.focus({ preventScroll: true });
        await usePromptAtIndex(item.originalIndex, card, { paste: !e.shiftKey });
      });

      // Arrow navigation is handled once at document level to avoid double-step jumps.
      card.onkeydown = (e) => {
        if (e.key === "Enter") {
          // 输入法组合态回车只确认候选，不触发粘贴。
          if (e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          e.stopPropagation();
          selectCard(item.originalIndex);
          void usePromptAtIndex(item.originalIndex, card, { paste: !e.shiftKey });
        }
      };

      const titleHtml = isSearching
        ? highlightMatch(item.name, term)
        : escapeHtml(item.name);
      const bodyHtml = isSearching
        ? highlightMatch(item.content, term)
        : escapeHtml(item.content);
      const tagHtml = isSearching
        ? highlightMatch(normalizedTag || "默认", term)
        : escapeHtml(normalizedTag || "默认");

      card.innerHTML = `
          <div class="card-header">
            <div class="card-content">
              <div class="card-title-row">
                <span class="card-rank" hidden></span>
                <div class="card-title">${titleHtml}</div>
                <span class="card-tag">${tagHtml}</span>
              </div>
              <div class="card-body">${bodyHtml}</div>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-usage">${escapeHtml(useText)}</span>
            <span class="card-last-used">${escapeHtml(lastUsedText)}</span>
          </div>
        `;

      card.oncontextmenu = (e) => {
        e.preventDefault();
        showContextMenu(e, item);
      };
      return card;
    };

    displayList.forEach((item) => {
      const normalizedTag = normalizeTag(item.tag);
      const matchesSearch = !isSearching || promptMatchesSearch(item, term);
      const matchesCategory =
        activeFilter === "all"
          ? !isTagHidden(normalizedTag)
          : normalizedTag === activeFilter;

      if (matchesSearch && matchesCategory) {
        visibleCount += 1;
        matchedItems.push(item);
        visibleIndices.push(item.originalIndex);
      }
    });

    if (isSearching) {
      matchedItems.sort((a, b) => comparePromptsForSearch(a, b, term));
      visibleIndices.length = 0;
      matchedItems.forEach((item) => visibleIndices.push(item.originalIndex));
      if (matchedItems.length > 0) {
        const resultList = createSection("搜索结果", "Enter 使用 · ⌘1-9");
        matchedItems.forEach((item) => {
          resultList.appendChild(createCard(item));
        });
      }
    } else {
      const pinnedItems = [];
      const recentItems = [];
      const regularItems = [];

      matchedItems.forEach((item) => {
        const card = createCard(item);
        if (item.isPinned) {
          pinnedItems.push(card);
        } else if (toTimestamp(item.lastUsedAt) > 0) {
          recentItems.push({ card, item });
        } else {
          regularItems.push(card);
        }
      });

      pinnedItems.sort((a, b) => {
        const left = allPrompts[Number(a.dataset.originalIndex)];
        const right = allPrompts[Number(b.dataset.originalIndex)];
        return comparePromptsForUse(left, right);
      });

      recentItems.sort((a, b) => comparePromptsForUse(a.item, b.item));

      const surfacedRecentItems = recentItems.slice(0, 4);
      const surfacedRecentSet = new Set(
        surfacedRecentItems.map(({ item }) => item.originalIndex),
      );
      const remainingRecentCards = recentItems
        .filter(({ item }) => !surfacedRecentSet.has(item.originalIndex))
        .map(({ card }) => card);

      regularItems.unshift(...remainingRecentCards);

      if (pinnedItems.length > 0) {
        const pinnedList = createSection("置顶", "1-9 一击即用");
        const pinnedSection = pinnedList.closest(".card-section");
        if (pinnedSection) pinnedSection.classList.add("card-section-pinned");
        pinnedItems.forEach((card) => pinnedList.appendChild(card));
      }

      if (surfacedRecentItems.length > 0) {
        const recentList = createSection("最近");
        surfacedRecentItems.forEach(({ card }) => recentList.appendChild(card));
      }

      if (regularItems.length > 0) {
        const regularList = createSection("全部");
        regularItems.sort((a, b) => {
          const left = allPrompts[Number(a.dataset.originalIndex)];
          const right = allPrompts[Number(b.dataset.originalIndex)];
          return comparePromptsForUse(left, right);
        });

        regularItems.forEach((card) => regularList.appendChild(card));
      }

      // Keep fallback selection order aligned with visual sections.
      visibleIndices.length = 0;
      pinnedItems.forEach((card) => visibleIndices.push(Number(card.dataset.originalIndex)));
      surfacedRecentItems.forEach(({ item }) => visibleIndices.push(item.originalIndex));
      regularItems.forEach((card) => visibleIndices.push(Number(card.dataset.originalIndex)));
    }

    // Annotate visible cards with shortcut ranks for the first nine.
    // 空搜索：数字键 1-9 一击即用，角标只显示数字；搜索中仍用 ⌘/Ctrl+1-9。
    const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");
    const modLabel = isApple ? "⌘" : "Ctrl+";
    getVisibleCards().forEach((card, idx) => {
      const rankEl = card.querySelector(".card-rank");
      if (idx < 9) {
        const rank = String(idx + 1);
        card.dataset.rank = rank;
        card.setAttribute(
          "aria-keyshortcuts",
          isSearching
            ? `Meta+${rank} Control+${rank}`
            : `${rank} Meta+${rank} Control+${rank}`,
        );
        if (rankEl) {
          rankEl.hidden = false;
          rankEl.textContent = isSearching ? `${modLabel}${rank}` : rank;
        }
      } else {
        delete card.dataset.rank;
        card.removeAttribute("aria-keyshortcuts");
        if (rankEl) {
          rankEl.hidden = true;
          rankEl.textContent = "";
        }
      }
    });
    if (cardGrid) {
      cardGrid.setAttribute("role", "listbox");
      cardGrid.setAttribute("aria-label", "提示词列表");
    }

    if (visibleCount === 0) {
      const isEmpty = allPrompts.length === 0;
      const noSearchMatch = !isEmpty && isSearching;
      const noCategoryMatch = !isEmpty && !isSearching && activeFilter !== "all";
      const title = isEmpty
        ? "还没有提示词"
        : noSearchMatch
          ? "没有匹配结果"
          : noCategoryMatch
            ? "这个分类是空的"
            : "没有可显示的提示词";
      const textHint = isEmpty
        ? "按 ⌘N 或点「新增」添加第一条。"
        : noSearchMatch
          ? "换个关键词，或清除搜索后再看全部。"
          : noCategoryMatch
            ? "换个分类，或把提示词移到这里。"
            : "检查一下隐藏分类设置。";
      cardGrid.innerHTML = `
        <div class="empty-state" role="status" aria-live="polite">
          <div class="empty-state-title">${escapeHtml(title)}</div>
          <div class="empty-state-text">${escapeHtml(textHint)}</div>
          <div class="empty-state-actions">
            ${isEmpty ? `
            <button class="empty-state-btn primary" type="button" id="emptyAddBtn">
              新增提示词
            </button>
            ` : ""}
            ${noSearchMatch ? `
            <button class="empty-state-btn primary" type="button" id="emptyClearSearchBtn">
              清除搜索
            </button>
            ` : ""}
            ${noCategoryMatch ? `
            <button class="empty-state-btn primary" type="button" id="emptyShowAllBtn">
              查看全部
            </button>
            ` : ""}
          </div>
        </div>
      `;
      const emptyAddBtn = document.getElementById("emptyAddBtn");
      if (emptyAddBtn) {
        emptyAddBtn.onclick = () => openAddPrompt();
      }
      const emptyClearSearchBtn = document.getElementById("emptyClearSearchBtn");
      if (emptyClearSearchBtn) {
        emptyClearSearchBtn.onclick = () => clearSearchInput({ focus: true });
      }
      const emptyShowAllBtn = document.getElementById("emptyShowAllBtn");
      if (emptyShowAllBtn) {
        emptyShowAllBtn.onclick = () => {
          const allNav = document.querySelector('.nav-item[data-filter="all"]');
          if (allNav) allNav.click();
          else {
            document.querySelectorAll(".nav-item").forEach((nav) => {
              const active = nav.dataset.filter === "all";
              nav.classList.toggle("active", active);
              nav.setAttribute("aria-pressed", active ? "true" : "false");
            });
            renderCards();
          }
        };
      }
      clearPreview();
      return;
    }

    if (visibleIndices.length === 0) {
      clearPreview();
      setActiveCardElement(null);
    } else if (isSearching) {
      // 搜索结果从顶部看起，避免仍停在上次滚动位置。
      if (cardGrid) cardGrid.scrollTop = 0;
      // 搜索时始终落到相关度第一名，Enter 与肌肉记忆一致；方向键仍可再移动。
      selectCard(visibleIndices[0], false, { instant: true });
    } else if (!visibleIndices.includes(selectedIndex)) {
      selectCard(visibleIndices[0], false, { instant: true });
    } else {
      // Re-bind active class after full re-render.
      selectCard(selectedIndex, false, { instant: true });
    }
  }

  function getSearchRawValue() {
    return String(searchInput?.value || "");
  }

  // 调用热键语义：仅空白视为空（可数字键 1-9 / E P）；有任意字符则 ⌫ 改搜索。
  function isSearchEffectivelyEmpty() {
    return !getSearchRawValue().trim();
  }

  function hasSearchInputChars() {
    return getSearchRawValue().length > 0;
  }

  function syncSearchClearButton() {
    if (!searchClearBtn) return;
    searchClearBtn.hidden = !hasSearchInputChars();
  }

  function clearSearchInput({ focus = false } = {}) {
    const hadValue = hasSearchInputChars();
    if (hadValue) {
      searchInput.value = "";
      syncSearchClearButton();
      renderCards();
      // 清空搜索回到干净列表：默认第一名，与再次唤起 / Esc 退层一致。
      selectFirstVisibleForCall();
    }
    if (focus) {
      searchInput.focus();
    }
    return hadValue;
  }

  let searchRenderRaf = 0;
  searchInput.addEventListener("input", () => {
    syncSearchClearButton();
    // 输入时合并到下一帧渲染，减少长列表连按卡顿。
    if (searchRenderRaf) cancelAnimationFrame(searchRenderRaf);
    searchRenderRaf = requestAnimationFrame(() => {
      searchRenderRaf = 0;
      renderCards();
    });
  });

  if (searchClearBtn) {
    searchClearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearSearchInput({ focus: true });
    });
  }
  syncSearchClearButton();

  searchInput.addEventListener("keydown", async (e) => {
    if (e.key === "Escape" && hasSearchInputChars()) {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      // 搜索框 Esc 只清查询，不藏窗；清完落到第一名。
      clearSearchInput({ focus: true });
      return;
    }
    if (e.key === "Enter") {
      // 中文输入法选词回车不触发使用，避免半成品提交。
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      // 搜索框回车：优先当前选中（可见），否则第一条。避免悬停/方向键选中后仍用第一名。
      let used = false;
      const visible = getVisiblePromptIndices();
      if (
        selectedIndex !== null &&
        allPrompts[selectedIndex] &&
        visible.includes(selectedIndex)
      ) {
        const card = document.querySelector(
          `.card[data-original-index="${selectedIndex}"]`,
        );
        await usePromptAtIndex(selectedIndex, card, { paste: !e.shiftKey });
        used = true;
      } else {
        used = await useVisiblePromptByRank(1, { paste: !e.shiftKey });
      }
      if (!used) {
        const firstCard = document.querySelector(".card");
        if (firstCard) {
          firstCard.focus({ preventScroll: true });
          selectCard(Number(firstCard.dataset.originalIndex), false, { instant: true });
          ensureCardVisible(firstCard);
        }
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        // 搜索框 Shift+Tab：落到列表末项，方便键盘回绕。
        const cards = getVisibleCards();
        if (cards.length) focusCardForCall(cards[cards.length - 1]);
        return;
      }
      // Tab：进入当前选中（或第一名），不要总是重置到 1。
      focusSelectedOrFirstCard();
    }
  });

  async function savePromptFromModal() {
    const name = document.getElementById("newName").value.trim();
    const tag = document.getElementById("newTag").value.trim();
    const content = document.getElementById("newContent").value.trim();

    if (!name || !content) {
      await safeAlert("名称和内容不能为空");
      return false;
    }

    const isEdit = editingIndex !== null;
    const previousItem =
      isEdit && allPrompts[editingIndex]
        ? { ...allPrompts[editingIndex] }
        : null;
    const previousSelected = selectedIndex;
    if (isEdit) {
      allPrompts[editingIndex] = {
        ...allPrompts[editingIndex],
        name,
        tag,
        content,
      };
      selectedIndex = editingIndex;
    } else {
      allPrompts.push({
        name,
        tag,
        content,
        isPinned: false,
        useCount: 0,
        lastUsedAt: "",
      });
      selectedIndex = allPrompts.length - 1;
    }

    modal.style.display = "none";
    syncBlurHideLock();
    clearPendingUndo();
    const ok = await saveData();
    if (!ok) {
      // 落盘失败：恢复内存与编辑弹层，表单值仍在输入框里。
      if (isEdit && previousItem) {
        allPrompts[editingIndex] = previousItem;
      } else if (!isEdit) {
        allPrompts.pop();
      }
      selectedIndex = previousSelected;
      if (modal) modal.style.display = "flex";
      syncBlurHideLock();
      renderAll();
      try { focusModalPrimaryField(); } catch {}
      showToast("保存失败，请重试");
      return false;
    }
    resetForm();
    if (selectedIndex !== null && allPrompts[selectedIndex]) {
      selectCard(selectedIndex, false, { instant: true });
    }
    showToast(isEdit ? "已保存修改" : "已新增提示词");
    return true;
  }

  saveBtn.onclick = async () => {
    await savePromptFromModal();
  };

  // 编辑弹层：⌘/Ctrl+Enter 保存，避免离开键盘去点按钮
  ["newName", "newTag", "newContent"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        void savePromptFromModal();
      }
    });
  });

  function resetForm() {
    editingIndex = null;
    document.getElementById("newName").value = "";
    document.getElementById("newTag").value = "";
    document.getElementById("newContent").value = "";
    modalTitle.innerText = "新增提示词";
  }

  tagInput.onfocus = () => {
    updateSidebarAndDropdown();
    tagDropdown.style.display = "block";
  };

  tagInput.onblur = () => {
    setTimeout(() => {
      tagDropdown.style.display = "none";
    }, 200);
  };

  function readPromptFormValues() {
    return {
      name: String(document.getElementById("newName")?.value || "").trim(),
      tag: String(document.getElementById("newTag")?.value || "").trim(),
      content: String(document.getElementById("newContent")?.value || "").trim(),
    };
  }

  function isPromptFormDirty() {
    if (!modal || modal.style.display !== "flex") return false;
    const form = readPromptFormValues();
    if (editingIndex !== null && allPrompts[editingIndex]) {
      const item = allPrompts[editingIndex];
      return (
        form.name !== String(item.name || "").trim() ||
        form.tag !== String(item.tag || "").trim() ||
        form.content !== String(item.content || "").trim()
      );
    }
    // 新增：任一字段有内容即视为脏，避免误 Esc 丢掉草稿。
    return Boolean(form.name || form.tag || form.content);
  }

  let discardFormArmedUntil = 0;
  function armDiscardPromptForm() {
    discardFormArmedUntil = Date.now() + 2500;
    showToast("未保存，再按 Esc 放弃", { duration: 2200 });
  }

  function closePromptModal({ force = false } = {}) {
    if (!modal || modal.style.display !== "flex") return false;
    if (!force && isPromptFormDirty()) {
      if (Date.now() > discardFormArmedUntil) {
        armDiscardPromptForm();
        return false;
      }
    }
    discardFormArmedUntil = 0;
    modal.style.display = "none";
    resetForm();
    syncBlurHideLock();
    return true;
  }

  function openAddPrompt(options = {}) {
    // 不依赖侧栏按钮 click：侧栏收起 inert 时 .click() 可能无效。
    // 未保存草稿时拒绝重置表单，避免 ⌘N / 顶栏新增 / 侧栏新增冲掉编辑。
    if (isDirtyPromptModalOpen()) {
      showToast("有未保存的编辑，请先保存或关闭", { duration: 2200 });
      try { focusModalPrimaryField(); } catch {}
      return false;
    }
    try { dismissSystemMenuForCallPath(); } catch {}
    try { hideContextMenu(); } catch {}
    resetForm();
    discardFormArmedUntil = 0;
    modal.style.display = "flex";
    syncBlurHideLock();
    if (options.focusTag && tagInput) {
      requestAnimationFrame(() => {
        tagInput.focus();
        tagInput.select();
      });
    } else {
      focusModalPrimaryField();
    }
    if (options.toast) showToast(String(options.toast));
    return true;
  }

  function resetCategoryFilterToAll() {
    // 再次唤起 / Esc 退层回到干净调用态：不把上次分类筛选带进调用。
    const allNav = document.querySelector('.nav-item[data-filter="all"]');
    if (!allNav) return false;
    if (allNav.classList.contains("active")) return false;
    document.querySelectorAll(".nav-item").forEach((nav) => {
      const active = nav === allNav;
      nav.classList.toggle("active", active);
      nav.setAttribute("aria-pressed", active ? "true" : "false");
    });
    return true;
  }

  if (addBtn) {
    addBtn.onclick = () => openAddPrompt();
  }
  if (headerAddBtn) {
    headerAddBtn.onclick = (e) => {
      e.preventDefault();
      openAddPrompt();
    };
  }

  if (addTagBtn) {
    addTagBtn.onclick = () => {
      // 与 openAddPrompt 同路径：锁失焦隐藏 + 保护未保存草稿。
      openAddPrompt({
        focusTag: true,
        toast: "输入新标签名称并保存提示词，即可创建分类",
      });
    };
  }

  if (cancelBtn) {
    cancelBtn.onclick = () => {
      closePromptModal({ force: true });
    };
  }

  // 点遮罩关闭编辑弹层：有未保存内容时与 Esc 一样二次确认。
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closePromptModal();
      }
    });
  }

  function buildExportPayload(format) {
    if (format === "markdown") {
      return {
        content: formatPromptsAsMarkdown(allPrompts),
        defaultPath: "prompts_export.md",
        filters: [
          { name: "Markdown", extensions: ["md", "markdown"] },
          { name: "All Files", extensions: ["*"] },
        ],
      };
    }
    if (format === "csv") {
      return {
        content: formatPromptsAsCsv(allPrompts),
        defaultPath: "prompts_export.csv",
        filters: [
          { name: "CSV", extensions: ["csv"] },
          { name: "All Files", extensions: ["*"] },
        ],
      };
    }
    return {
      content: formatPromptsAsJson(allPrompts),
      defaultPath: "prompts_backup.json",
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "All Files", extensions: ["*"] },
      ],
    };
  }

  async function applyImportedPrompts(importedPrompts, { sourceLabel = "导入" } = {}) {
    const list = sanitizePromptList(importedPrompts);
    if (list.length === 0) {
      await safeAlert(`${sourceLabel}失败：未解析到有效提示词`);
      return false;
    }

    let mode = "replace";
    if (allPrompts.length > 0) {
      if (electronAPI?.chooseImportMode) {
        mode = await electronAPI.chooseImportMode({
          importCount: list.length,
          existingCount: allPrompts.length,
        });
      } else {
        const useMerge = await safeConfirm(
          `检测到 ${list.length} 条提示词。\n确定 = 合并导入；取消 = 改为替换全部。`,
        );
        mode = useMerge ? "merge" : "replace";
      }
    }
    if (mode === "cancel") return false;

    if (mode === "merge") {
      const before = clonePromptList(allPrompts);
      const merged = mergePromptLists(allPrompts, list);
      allPrompts = merged.prompts;
      selectedIndex = null;
      clearPendingUndo();
      const ok = await saveData();
      if (!ok) {
        allPrompts = before;
        renderAll();
        showToast("合并导入未能保存");
        return false;
      }
      showToast(
        merged.skipped > 0
          ? `已合并 ${merged.added} 条，跳过重复 ${merged.skipped} 条`
          : `已合并 ${merged.added} 条`,
      );
      return true;
    }

    const previous = clonePromptList(allPrompts);
    allPrompts = list;
    selectedIndex = null;
    pendingUndo = {
      type: "replace",
      prompts: previous,
    };
    const ok = await saveData();
    if (!ok) {
      allPrompts = previous;
      pendingUndo = null;
      renderAll();
      showToast("替换导入未能保存");
      return false;
    }
    showToast(`已替换导入 ${list.length} 条`, {
      actionLabel: previous.length > 0 ? "撤销" : "",
      onAction: previous.length > 0 ? () => applyPendingUndo() : null,
    });
    return true;
  }

  async function importPromptsFromRaw(raw, format = "json", sourceLabel = "导入") {
    let importedPrompts = [];
    try {
      importedPrompts = extractPromptsFromImport(raw, format);
    } catch (parseErr) {
      if (format === "json") {
        try {
          importedPrompts = extractPromptsFromImport(raw, "markdown");
        } catch {
          try {
            importedPrompts = extractPromptsFromImport(raw, "csv");
          } catch {
            throw parseErr;
          }
        }
      } else {
        throw parseErr;
      }
    }
    return applyImportedPrompts(importedPrompts, { sourceLabel });
  }

  if (menuExport) menuExport.onclick = async () => {
    try {
      assertElectron();
      let format = "json";
      if (electronAPI?.chooseExportFormat) {
        format = await electronAPI.chooseExportFormat();
      }
      if (format === "cancel") return;
      if (!["json", "markdown", "csv"].includes(format)) format = "json";
      const payload = buildExportPayload(format);
      const result = await electronAPI.exportPrompts(payload);
      if (!result?.canceled && result?.filePath) {
        const name = result.filePath.split(/[/\\]/).pop();
        showToast(`已导出：${name}`);
      }
    } catch (err) {
      if (!String(err).includes("取消")) {
        await safeAlert(`导出失败: ${err?.message || err}`);
      }
    }
    try { setSystemMenuOpen(false); } catch {}
  };


  if (menuSafetyRestore) {
    menuSafetyRestore.onclick = async () => {
      try {
        assertElectron();
        const result = await electronAPI?.restoreLatestSafetySnapshot?.();
        if (result?.canceled) {
          if (result?.reason === "empty") {
            showToast("暂无安全快照");
          }
          try { setSystemMenuOpen(false); } catch {}
          return;
        }
        const previous = clonePromptList(allPrompts);
        allPrompts = await loadPrompts();
        selectedIndex = null;
        pendingUndo = previous.length
          ? { type: "replace", prompts: previous }
          : null;
        renderAll();
        showToast(`已恢复安全快照（${result?.promptsCount ?? allPrompts.length} 条）`, {
          actionLabel: previous.length > 0 ? "撤销" : "",
          onAction: previous.length > 0 ? () => applyPendingUndo() : null,
        });
      } catch (err) {
        await safeAlert(`恢复安全快照失败: ${err?.message || err}`);
      }
      try { setSystemMenuOpen(false); } catch {}
    };
  }

  if (menuHiddenTags) {
    menuHiddenTags.onclick = () => {
      openHiddenTagsModal();
      try { setSystemMenuOpen(false); } catch {}
    };
  }

  if (menuTheme) {
    menuTheme.onclick = () => {
      cycleThemeMode();
      try { setSystemMenuOpen(false); } catch {}
    };
  }

  if (menuOpenAtLogin) {
    menuOpenAtLogin.onclick = async () => {
      await toggleOpenAtLogin();
      try { setSystemMenuOpen(false); } catch {}
    };
  }

  if (menuHotkey) {
    menuHotkey.onclick = async () => {
      try {
        assertElectron();
        let info = null;
        if (electronAPI?.getHotkeyInfo) {
          info = await electronAPI.getHotkeyInfo();
        }
        if (info?.isFallback && electronAPI?.pinActiveGlobalHotkey) {
          info = await electronAPI.pinActiveGlobalHotkey();
          showToast(`已固定快捷键：${info?.active || "当前键"}`);
        } else if (electronAPI?.cycleGlobalHotkey) {
          info = await electronAPI.cycleGlobalHotkey();
          const active = info?.active || "Alt+E";
          if (info?.isFallback) {
            showToast(`已切换偏好，当前实际：${active}（已回退）`);
          } else {
            showToast(`已切换全局快捷键：${active}`);
          }
        }
        await refreshHotkeyMenu();
        // 快捷键说明/托盘 tip 已由主进程更新；关于页下次打开也会读到新值。
      } catch (err) {
        await safeAlert(`切换快捷键失败: ${err?.message || err}`);
      }
      try { setSystemMenuOpen(false); } catch {}
    };
  }


  if (menuShortcuts) {
    menuShortcuts.onclick = async () => {
      const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");
      const mod = isApple ? "⌘" : "Ctrl+";
      const searchHotkey = isApple ? "⌘K" : "Ctrl+K";
      const settingsHotkey = isApple ? "⌘," : "Ctrl+,";
      let globalHotkey = "Alt+E";
      try {
        const remote = await electronAPI?.getAppInfo?.();
        if (remote?.globalHotkey) globalHotkey = String(remote.globalHotkey);
      } catch {}
      const detail = [
        "快捷键说明",
        "",
        "全局",
        `  ${globalHotkey.padEnd(14, " ")} 显示 / 隐藏窗口（启动后默认后台待命）`,
        "  系统菜单·全局快捷键  切换候选；回退时可一点固定",
        "",
        "调用主路径",
        "  Enter           使用当前选中（Shift+Enter 仅复制；搜索框同理）",
        "  1-9            空搜索时使用第 N 条（Shift 仅复制）",
        `  ${mod}1-9         任意时候使用第 N 条（搜索中也可用）`,
        "  ↑ / ↓           在列表中移动选中",
        "  PgUp / PgDn     按页跳选",
        "  Tab / ⇧Tab      搜索 ↔ 列表",
        `  / 或 ${searchHotkey} / ${isApple ? "⌘F" : "Ctrl+F"}  聚焦搜索`,
        "  Esc             关层 / toast → 清搜索 → 重置分类 → 隐藏",
        "",
        "其他",
        "  [               折叠 / 展开预览",
        "  ]               折叠 / 展开侧栏",
        "  E               编辑当前选中（搜索为空时）",
        "  P               置顶 / 取消置顶（搜索为空时）",
        "  Delete / ⌫      空搜索时删除选中（可撤销；有搜索词时 ⌫ 改搜索）",
        `  ${isApple ? "⌘N" : "Ctrl+N"}             新增提示词`,
        `  ${settingsHotkey}            打开系统菜单`,
        "  单击卡片         立即使用（Shift+单击仅复制）",
        "  右键卡片         复制 / 副本 / 分享 / 编辑 / 删除（删除可 ⌘Z 撤销）",
        `  ${isApple ? "⌘D" : "Ctrl+D"}            创建当前选中副本`,
        `  ${isApple ? "⌘⇧P" : "Ctrl+Shift+P"}     置顶 / 取消置顶`,
        `  ${isApple ? "⌘⇧C" : "Ctrl+Shift+C"}     复制当前选中内容`,
        "  拖入文件         导入 JSON / Markdown / CSV",
        `  ${isApple ? "⌘Z" : "Ctrl+Z"}            撤销最近删除/替换导入`,
        `  ${isApple ? "⌘⇧L" : "Ctrl+Shift+L"}     切换主题（跟随系统 / 浅色 / 深色）`,
      ].join("\n");
      await safeAlert(detail);
      try { setSystemMenuOpen(false); } catch {}
    };
  }

  if (menuAbout) {
    menuAbout.onclick = async () => {
      let info = { name: "PromptBox", version: "0.3.0", platform: "unknown", isPackaged: false };
      try {
        assertElectron();
        const remote = await electronAPI?.getAppInfo?.();
        if (remote && typeof remote === "object") {
          info = { ...info, ...remote };
        }
      } catch (err) {
        console.error("读取应用信息失败", err);
      }
      const detail = [
        `${info.name || "PromptBox"}`,
        `版本：${info.version || "未知"}`,
        `平台：${info.platform || "未知"}`,
        `运行：${info.isPackaged ? "打包版" : "开发模式"}`,
        "",
        "定位：全局快捷键唤起的 Prompt 快速调用层",
        `主路径：${info.globalHotkey || "Alt+E"} → 搜索/选择 → 使用 → 回到原应用`,
      ].join("\n");
      await safeAlert(detail);
      try { setSystemMenuOpen(false); } catch {}
    };
  }

  if (menuPermissions) {
    menuPermissions.onclick = async () => {
      let diagnostics = null;
      try {
        assertElectron();
        diagnostics = await electronAPI?.getPermissionDiagnostics?.();
      } catch (err) {
        console.error("读取权限诊断失败", err);
      }

      const targetName = diagnostics?.targetName || "Electron";
      const targetPath = diagnostics?.targetPath || "未知";
      const accessibilityTrusted = diagnostics?.accessibilityTrusted;
      const isPackaged = Boolean(diagnostics?.isPackaged);
      const detail = [
        "权限说明",
        "",
        "1. 自动粘贴依赖两类 macOS 权限：",
        "   - 辅助功能：允许发送键盘操作",
        "   - 自动化：允许控制 System Events",
        "2. 全局快捷键在部分机器上也可能依赖辅助功能权限。",
        isPackaged
          ? `3. 当前运行目标：${targetName}`
          : `3. 当前是开发模式，应授权“${targetName}”，不是“PromptBox”。`,
        `4. 可执行文件路径：${targetPath}`,
        accessibilityTrusted === false
          ? "5. 当前检测结果：辅助功能尚未授权。"
          : accessibilityTrusted === true
            ? "5. 当前检测结果：辅助功能已授权；若仍无法自动粘贴，请检查“自动化 -> Electron -> System Events”。"
            : "5. 当前检测结果：暂时无法读取辅助功能状态。",
        "",
        "点击“确定”后将尝试打开“辅助功能”设置页。",
        "若辅助功能已开但仍不能自动粘贴，再到“自动化”里允许 Electron 控制 System Events。",
      ].join("\n");

      await safeAlert(detail);
      if (accessibilityTrusted === false) {
        await openAccessibilitySettings();
      } else {
        await openAutomationSettings();
      }
      try { setSystemMenuOpen(false); } catch {}
    };
  }

  if (menuWebdav) menuWebdav.onclick = () => {
    (async () => {
      openWebdavModal();
      try { setSystemMenuOpen(false); } catch {}
      const config = await loadWebdavConfig();
      if (config) {
        if (webdavUrl) webdavUrl.value = config.url || "";
        if (webdavUsername) webdavUsername.value = config.username || "";
        if (webdavPassword) webdavPassword.value = config.password || "";
        if (webdavDir) webdavDir.value = config.directory || "prompt-box-backups";
        if (webdavConfigJson) {
          webdavConfigJson.value = JSON.stringify(buildWebdavSnapshot(config), null, 2);
        }
      }
      if (electronAPI?.getWebdavSettings) {
        const settings = await electronAPI.getWebdavSettings();
        if (webdavAutoBackup) webdavAutoBackup.checked = !!settings?.autoBackupEnabled;
        if (webdavIntervalDays) webdavIntervalDays.value = String(settings?.intervalDays ?? 3);
      }
      await loadWebdavBackups();
    })();
  };

  if (menuImport) menuImport.onclick = async () => {
    try {
      assertElectron();
      const result = await electronAPI.importPrompts();
      if (result?.canceled) return;
      const format =
        result.format === "markdown" || result.format === "csv"
          ? result.format
          : "json";
      await importPromptsFromRaw(result.raw, format, "导入");
    } catch (err) {
      if (!String(err).includes("取消")) {
        await safeAlert(`导入失败: ${err?.message || err}`);
      }
    }
    try { setSystemMenuOpen(false); } catch {}
  };

  if (previewUse) {
    previewUse.onclick = async (e) => {
      if (selectedIndex === null || !allPrompts[selectedIndex]) return;
      const card = document.querySelector(
        `.card[data-original-index="${selectedIndex}"]`,
      );
      await usePromptAtIndex(selectedIndex, card, { paste: !e.shiftKey });
    };
  }

  if (previewShare) {
    previewShare.onclick = async () => {
      if (selectedIndex === null) return;
      await sharePromptAtIndex(selectedIndex, "markdown");
    };
  }

  if (previewEdit) {
    previewEdit.onclick = () => {
      if (selectedIndex === null) return;
      openEditModal(selectedIndex);
    };
  }

  if (previewPin) {
    previewPin.onclick = async () => {
      if (selectedIndex === null || !allPrompts[selectedIndex]) return;
      const prev = allPrompts[selectedIndex].isPinned === true;
      allPrompts[selectedIndex].isPinned = !prev;
      const ok = await saveData();
      if (!ok) {
        allPrompts[selectedIndex].isPinned = prev;
        renderAll();
        showToast("置顶状态未能保存");
        return;
      }
      showToast(allPrompts[selectedIndex]?.isPinned ? "已置顶" : "已取消置顶");
    };
  }

  if (previewDelete) {
    previewDelete.onclick = async () => {
      if (selectedIndex === null) return;
      await deletePromptAtIndex(selectedIndex);
    };
  }

  if (webdavClose) {
    webdavClose.onclick = () => closeWebdavModal();
  }

  if (hiddenTagsClose) {
    hiddenTagsClose.onclick = () => closeHiddenTagsModal();
  }

  if (hiddenTagsCancel) {
    hiddenTagsCancel.onclick = () => closeHiddenTagsModal();
  }

  if (hiddenTagsSave) {
    hiddenTagsSave.onclick = () => {
      saveHiddenTagsSelection();
    };
  }

  if (renameTagClose) {
    renameTagClose.onclick = () => closeRenameTagModal();
  }

  if (renameTagCancel) {
    renameTagCancel.onclick = () => closeRenameTagModal();
  }

  if (renameTagSave) {
    renameTagSave.onclick = () => {
      handleRenameTagSave().catch((err) => {
        console.error("重命名分类失败", err);
        setRenameTagError(err?.message || "重命名失败");
      });
    };
  }

  if (webdavOverlay) {
    webdavOverlay.addEventListener("click", (e) => {
      if (e.target === webdavOverlay) closeWebdavModal();
    });
  }

  if (hiddenTagsOverlay) {
    hiddenTagsOverlay.addEventListener("click", (e) => {
      if (e.target === hiddenTagsOverlay) closeHiddenTagsModal();
    });
  }

  if (renameTagOverlay) {
    renameTagOverlay.addEventListener("click", (e) => {
      if (e.target === renameTagOverlay) closeRenameTagModal();
    });
  }

  if (renameTagInput) {
    renameTagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        handleRenameTagSave().catch((err) => {
          console.error("重命名分类失败", err);
          setRenameTagError(err?.message || "重命名失败");
        });
      }
    });
  }

  if (webdavRefresh) {
    webdavRefresh.onclick = async () => {
      try {
        if (!(await saveWebdavConfig())) return;
        await loadWebdavBackups();
        showToast("已刷新");
      } catch (err) {
        await safeAlert(`刷新失败: ${err}`);
      }
    };
  }

  if (webdavTest) {
    webdavTest.onclick = async () => {
      try {
        if (!(await saveWebdavConfig())) return;
        await electronAPI.testWebdav();
        showToast("WebDAV 连接成功");
      } catch (err) {
        await safeAlert(`连接失败: ${err}`);
      }
    };
  }

  if (webdavBackup) {
    webdavBackup.onclick = async () => {
      try {
        if (!(await saveWebdavConfig())) return;
        const result = await electronAPI.backupWebdav();
        await loadWebdavBackups();
        if (result?.fileName) {
          showToast(`已备份：${result.fileName}`);
        } else {
          showToast("已备份");
        }
      } catch (err) {
        await safeAlert(`备份失败: ${err}`);
      }
    };
  }

  if (webdavRestore) {
    webdavRestore.onclick = async () => {
      try {
        if (!(await saveWebdavConfig())) return;
        if (!(await safeConfirm("将从 WebDAV 恢复，当前本地内容将被覆盖。继续吗？"))) {
          return;
        }
        let result;
        const path = webdavRestorePath?.value?.trim();
        const selected = webdavBackupList?.value;
        if (path) {
          result = await electronAPI.restoreWebdavPath(path);
        } else if (selected && selected.trim()) {
          result = await electronAPI.restoreWebdavPath(selected);
        } else {
          await safeAlert("暂无可恢复的云端备份，请先刷新列表或立即备份。");
          return;
        }
        // 覆盖前留下可撤销快照，避免云端恢复误操作不可回退。
        const previous = clonePromptList(allPrompts);
        allPrompts = await loadPrompts();
        selectedIndex = null;
        pendingUndo = previous.length
          ? { type: "replace", prompts: previous }
          : null;
        renderAll();
        showToast(`已恢复 ${result?.promptsCount ?? allPrompts.length} 条`, {
          actionLabel: previous.length > 0 ? "撤销" : "",
          onAction: previous.length > 0 ? () => applyPendingUndo() : null,
        });
      } catch (err) {
        await safeAlert(`恢复失败: ${err}`);
      }
    };
  }

  const intervalField = document.getElementById("intervalField");
  
  function updateIntervalFieldVisibility() {
    if (intervalField) {
      intervalField.style.display = webdavAutoBackup?.checked ? "block" : "none";
    }
  }
  
  if (webdavAutoBackup || webdavIntervalDays) {
    const saveSettings = async () => {
      if (!electronAPI?.setWebdavSettings) return;
      const enabled = !!webdavAutoBackup?.checked;
      const days = Number(webdavIntervalDays?.value || 3);
      await electronAPI.setWebdavSettings({
        autoBackupEnabled: enabled,
        intervalDays: Math.max(1, Math.min(days, 30)),
      });
      updateIntervalFieldVisibility();
    };
    if (webdavAutoBackup) {
      webdavAutoBackup.onchange = saveSettings;
      // Initialize visibility
      updateIntervalFieldVisibility();
    }
    if (webdavIntervalDays) webdavIntervalDays.onchange = saveSettings;
  }

  // Copy Config Modal Functions
  function openCopyConfigModal() {
    if (!copyConfigOverlay || !copyConfigText) return;
    const config = collectWebdavConfig();
    copyConfigText.value = JSON.stringify(buildWebdavSnapshot(config), null, 2);
    copyConfigOverlay.style.display = "flex";
    syncBlurHideLock();
  }

  function closeCopyConfigModal() {
    if (copyConfigOverlay) copyConfigOverlay.style.display = "none";
    try { syncBlurHideLock(); } catch {}
  }

  // Paste Config Modal Functions
  function openPasteConfigModal() {
    if (!pasteConfigOverlay) return;
    if (pasteConfigText) pasteConfigText.value = "";
    pasteConfigOverlay.style.display = "flex";
    syncBlurHideLock();
  }

  function closePasteConfigModal() {
    if (pasteConfigOverlay) pasteConfigOverlay.style.display = "none";
    try { syncBlurHideLock(); } catch {}
  }

  async function applyPastedConfig() {
    try {
      const raw = pasteConfigText?.value?.trim();
      if (!raw) {
        await safeAlert("请粘贴配置 JSON");
        return;
      }
      const parsed = JSON.parse(raw);
      const cfg = parsed.webdavConfig || {};
      let url = cfg.url || "";
      if (typeof url === "string" && url.includes("jianguoyun-dav-proxy")) {
        url = "https://dav.jianguoyun.com/dav/";
      }
      if (webdavUrl) webdavUrl.value = url;
      if (webdavUsername) webdavUsername.value = cfg.username || "";
      if (webdavPassword) webdavPassword.value = cfg.password || "";
      if (webdavDir) webdavDir.value = cfg.directory || "prompt-box-backups";
      if (!(await saveWebdavConfig())) return;
      closePasteConfigModal();
      showToast("配置已应用");
    } catch (err) {
      await safeAlert(`解析失败: ${err}`);
    }
  }

  // Copy Config Button
  if (webdavCopyConfig) {
    webdavCopyConfig.onclick = openCopyConfigModal;
  }

  // Paste Config Button
  if (webdavPasteConfig) {
    webdavPasteConfig.onclick = openPasteConfigModal;
  }

  // Copy Config Modal Events
  if (copyConfigClose) copyConfigClose.onclick = closeCopyConfigModal;
  if (copyConfigOverlay) {
    copyConfigOverlay.onclick = (e) => {
      if (e.target === copyConfigOverlay) closeCopyConfigModal();
    };
  }
  if (copyConfigBtn) {
    copyConfigBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(copyConfigText?.value || "");
        // 配置复制成功不 toast，关弹层即可。
        closeCopyConfigModal();
      } catch (err) {
        await safeAlert(`复制失败: ${err}`);
      }
    };
  }

  // Paste Config Modal Events
  if (pasteConfigClose) pasteConfigClose.onclick = closePasteConfigModal;
  if (pasteConfigCancel) pasteConfigCancel.onclick = closePasteConfigModal;
  if (pasteConfigOverlay) {
    pasteConfigOverlay.onclick = (e) => {
      if (e.target === pasteConfigOverlay) closePasteConfigModal();
    };
  }
  if (pasteConfigApply) pasteConfigApply.onclick = applyPastedConfig;

  function isTypingTarget(target) {
    if (!target) return false;
    const tagName = target.tagName;
    return (
      target.isContentEditable ||
      tagName === "INPUT" ||
      tagName === "TEXTAREA" ||
      tagName === "SELECT"
    );
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // 输入法取消组合优先，不顺手清搜索/关窗。
      if (e.isComposing || e.keyCode === 229) return;
      if (contextMenu?.style.display === "block") {
        hideContextMenu();
        return;
      }
      if (isSystemMenuOpen()) {
        setSystemMenuOpen(false);
        return;
      }
      if (modal?.style.display === "flex") {
        closePromptModal();
        return;
      }
      if (pasteConfigOverlay?.style.display === "flex") {
        closePasteConfigModal();
        return;
      }
      if (copyConfigOverlay?.style.display === "flex") {
        closeCopyConfigModal();
        return;
      }
      if (renameTagOverlay?.style.display === "flex") {
        closeRenameTagModal();
        return;
      }
      if (hiddenTagsOverlay?.style.display === "flex") {
        closeHiddenTagsModal();
        return;
      }
      if (webdavOverlay?.style.display === "flex") {
        closeWebdavModal();
        return;
      }
      // 先收起 toast（含撤销入口），再逐步回到干净调用态，最后才退场。
      const toast = document.getElementById("toast");
      if (toast && toast.style.display === "flex" && toast.style.opacity !== "0") {
        hideToast();
        return;
      }
      // Esc 分层：清空搜索 → 重置分类 → 隐藏窗口（启动器肌肉记忆）。
      if (searchInput && hasSearchInputChars()) {
        e.preventDefault();
        clearSearchInput({ focus: true });
        return;
      }
      if (resetCategoryFilterToAll()) {
        e.preventDefault();
        renderAll();
        selectFirstVisibleForCall();
        if (searchInput) searchInput.focus();
        return;
      }
      closeCurrentWindowSilently();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      if (!isBlockingLayerOpen() && !isTypingTarget(e.target) && pendingUndo) {
        e.preventDefault();
        void applyPendingUndo();
        return;
      }
    }

    // ⌘/Ctrl+N：新增（管理动作，不抢调用主路径）
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && !e.shiftKey && !e.altKey) {
      if (!isBlockingLayerOpen()) {
        e.preventDefault();
        openAddPrompt();
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && !e.shiftKey && !e.altKey) {
      if (!isBlockingLayerOpen() && !isTypingTarget(e.target) && selectedIndex !== null) {
        e.preventDefault();
        void duplicatePromptAtIndex(selectedIndex);
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
      if (!isBlockingLayerOpen() && !isTypingTarget(e.target) && selectedIndex !== null) {
        e.preventDefault();
        void togglePinAtIndex(selectedIndex);
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
      if (!isBlockingLayerOpen() && !isTypingTarget(e.target) && selectedIndex !== null) {
        e.preventDefault();
        void copyPromptContentAtIndex(selectedIndex);
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "l") {
      if (!isBlockingLayerOpen() && !isTypingTarget(e.target)) {
        e.preventDefault();
        cycleThemeMode();
        return;
      }
    }

    if (
      (e.metaKey || e.ctrlKey) &&
      (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "f") &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }

    // ⌘/Ctrl+Backspace：清空搜索（调用路径快速重来）
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key === "Backspace" &&
      !e.shiftKey &&
      !e.altKey &&
      !isBlockingLayerOpen()
    ) {
      if (e.target === searchInput || !isTypingTarget(e.target)) {
        e.preventDefault();
        clearSearchInput({ focus: true });
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      toggleSystemMenu();
      return;
    }

    // ⌘/Ctrl + 1-9：快速使用；⌘/Ctrl + Shift + 1-9：仅复制
    // 系统菜单不阻挡调用主路径，打开时先收起再执行。
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      /^[1-9]$/.test(e.key) &&
      !e.isComposing &&
      e.keyCode !== 229
    ) {
      if (!isModalLayerOpen() && (!isTypingTarget(e.target) || e.target === searchInput)) {
        e.preventDefault();
        dismissSystemMenuForCallPath();
        void useVisiblePromptByRank(Number(e.key), { paste: !e.shiftKey });
        return;
      }
    }

    // 空搜索时数字键 1-9 直接使用第 N 条（置顶/最近肌肉记忆）；搜索中不抢数字输入。
    // 输入法组合态（选词 1-9）绝不抢键。
    if (
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      /^[1-9]$/.test(e.key) &&
      !e.isComposing &&
      e.keyCode !== 229 &&
      !isModalLayerOpen() &&
      isSearchEffectivelyEmpty() &&
      (!isTypingTarget(e.target) || e.target === searchInput)
    ) {
      e.preventDefault();
      dismissSystemMenuForCallPath();
      void useVisiblePromptByRank(Number(e.key), { paste: !e.shiftKey });
      return;
    }

    // Enter：非输入态时使用当前选中项；无选中时回退可见第一名（与数字键 1 一致）。
    // Shift+Enter 仅复制。
    if (
      e.key === "Enter" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.isComposing &&
      e.keyCode !== 229 &&
      !isModalLayerOpen() &&
      !isTypingTarget(e.target) &&
      e.target !== searchInput
    ) {
      e.preventDefault();
      dismissSystemMenuForCallPath();
      if (selectedIndex !== null && allPrompts[selectedIndex]) {
        const visible = getVisiblePromptIndices();
        if (visible.includes(selectedIndex)) {
          const card = document.querySelector(
            `.card[data-original-index="${selectedIndex}"]`,
          );
          void usePromptAtIndex(selectedIndex, card, { paste: !e.shiftKey });
          return;
        }
      }
      void useVisiblePromptByRank(1, { paste: !e.shiftKey });
      return;
    }

    // 调用层焦点闭环：卡片上 Shift+Tab 回搜索，避免掉进顶栏按钮。
    if (
      e.key === "Tab" &&
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isModalLayerOpen() &&
      e.target?.closest?.(".card")
    ) {
      e.preventDefault();
      if (searchInput) {
        searchInput.focus();
        // 不 select，保留已输入关键词便于继续改。
      }
      return;
    }

    if (
      (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      const isSearchFocused = e.target === searchInput;
      if (!isModalLayerOpen() && (!isTypingTarget(e.target) || isSearchFocused)) {
        const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
        const moved = focusAdjacentCard(step);
        if (moved) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

    // Home / End：跳到当前可见列表首尾，方便键盘长列表。
    // 搜索框为空时也允许（光标在搜索框），有关键字时保留输入框 Home/End 行为。
    if (
      (e.key === "Home" || e.key === "End") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isModalLayerOpen() &&
      (!isTypingTarget(e.target) ||
        (e.target === searchInput && isSearchEffectivelyEmpty()))
    ) {
      const cards = getVisibleCards();
      if (cards.length) {
        const target = e.key === "Home" ? cards[0] : cards[cards.length - 1];
        e.preventDefault();
        e.stopPropagation();
        markKeyboardNavigation();
        target.focus({ preventScroll: true });
        selectCard(Number(target.dataset.originalIndex), false, { instant: true });
        ensureCardVisible(target);
        return;
      }
    }

    // PageUp / PageDown：按可见页距跳选，长列表不用连按方向键。
    if (
      (e.key === "PageUp" || e.key === "PageDown") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isModalLayerOpen() &&
      (!isTypingTarget(e.target) || e.target === searchInput)
    ) {
      const cards = getVisibleCards();
      if (cards.length) {
        e.preventDefault();
        e.stopPropagation();
        let currentIndex = -1;
        if (selectedIndex !== null) {
          currentIndex = cards.findIndex(
            (card) => Number(card.dataset.originalIndex) === selectedIndex,
          );
        }
        if (currentIndex < 0) currentIndex = 0;
        const pageSize = Math.max(3, Math.min(8, cards.length));
        const nextIndex =
          e.key === "PageDown"
            ? Math.min(cards.length - 1, currentIndex + pageSize)
            : Math.max(0, currentIndex - pageSize);
        const target = cards[nextIndex];
        if (target) {
          markKeyboardNavigation();
          target.focus({ preventScroll: true });
          selectCard(Number(target.dataset.originalIndex), false, { instant: true });
          ensureCardVisible(target);
        }
        return;
      }
    }

    // 中文输入法组合态不拦截，避免半成品字母触发编辑/搜索。
    const isComposingKey =
      e.isComposing || e.key === "Process" || e.keyCode === 229;
    // 仅空白不算搜索中：避免空格卡住 1-9 / E P。
    const searchIsEmpty = isSearchEffectivelyEmpty();

    // 管理快捷键（不抢调用主路径：仅在非输入态生效）
    // e/p 仅在搜索框为空时生效，这样输入 "expert" 时首字母 e 会进入搜索而不是误开编辑。
    if (
      !isComposingKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isBlockingLayerOpen() &&
      !isTypingTarget(e.target)
    ) {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (
        searchIsEmpty &&
        key === "e" &&
        selectedIndex !== null &&
        allPrompts[selectedIndex]
      ) {
        e.preventDefault();
        openEditModal(selectedIndex);
        return;
      }
      if (
        searchIsEmpty &&
        key === "p" &&
        selectedIndex !== null &&
        allPrompts[selectedIndex]
      ) {
        e.preventDefault();
        void togglePinAtIndex(selectedIndex);
        return;
      }
      // 输入框有字符时 ⌫ 回改搜索（含仅空格），绝不误删提示词。
      if (key === "Backspace" && hasSearchInputChars()) {
        e.preventDefault();
        dismissSystemMenuForCallPath();
        const current = String(searchInput.value || "");
        searchInput.focus();
        searchInput.value = current.slice(0, -1);
        const caret = searchInput.value.length;
        try {
          searchInput.setSelectionRange(caret, caret);
        } catch {}
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      // 空搜索：Delete / macOS ⌫ 删除选中（可撤销）。
      // macOS 退格键是 Backspace；Fn+Delete 才是 Delete。
      if (
        (key === "Delete" || key === "Backspace") &&
        searchIsEmpty &&
        !hasSearchInputChars() &&
        selectedIndex !== null &&
        allPrompts[selectedIndex]
      ) {
        e.preventDefault();
        void deletePromptAtIndex(selectedIndex);
        return;
      }
    }

    // 启动器手感：非输入态直接打字即搜索（调用主路径优先于管理键）。
    if (
      !isComposingKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isModalLayerOpen() &&
      !isTypingTarget(e.target) &&
      e.key.length === 1 &&
      e.key !== "/" && // / 聚焦并全选
      e.key !== "[" && // [ 折叠预览，不进搜索
      e.key !== "]" // ] 折叠侧栏，不进搜索
    ) {
      const lower = e.key.toLowerCase();
      const reservedManage =
        searchIsEmpty &&
        (lower === "e" || lower === "p") &&
        selectedIndex !== null &&
        allPrompts[selectedIndex];
      // 空搜索时忽略前导空格，避免只敲空格触发无意义过滤态。
      if (e.key === " " && searchIsEmpty) {
        e.preventDefault();
        return;
      }
      if (!reservedManage) {
        e.preventDefault();
        dismissSystemMenuForCallPath();
        const ch = e.key;
        // 从列表跳进搜索时一律追加到末尾，避免残留选区把已有关键词整段替换掉。
        const current = String(searchInput.value || "");
        searchInput.focus();
        searchInput.value = current + ch;
        const caret = searchInput.value.length;
        try {
          searchInput.setSelectionRange(caret, caret);
        } catch {}
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
    }

    // [ : 折叠/展开预览
    if (e.key === "[" && !isTypingTarget(e.target) && !isModalLayerOpen()) {
      e.preventDefault();
      togglePreviewCollapsed();
      return;
    }

    // ] : 折叠/展开侧栏（管理区下沉，调用层更宽）
    if (e.key === "]" && !isTypingTarget(e.target) && !isModalLayerOpen()) {
      e.preventDefault();
      toggleSidebarCollapsed();
      return;
    }

    if (e.key === "/" && !isTypingTarget(e.target)) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  if (searchInput) {
    searchInput.placeholder = "搜索 · 直接打字 · 多词 · / 或 ⌘K";
    if (previewUse) {
      previewUse.title = "立即使用（Shift 仅复制）";
    }
    if (previewEdit) previewEdit.title = "编辑 (E，空搜索时)";
    if (previewPin) previewPin.title = "置顶 (P，空搜索时)";
    if (previewDelete) previewDelete.title = "删除 (Delete/⌫，可撤销)";
    searchInput.setAttribute("aria-label", "搜索提示词");
  }
  if (settingsBtn) {
    settingsBtn.title = "设置 (⌘,)";
  }
  previewCollapsed = loadPreviewCollapsed();
  applyPreviewCollapsed();
  if (previewToggleBtn) {
    previewToggleBtn.onclick = () => togglePreviewCollapsed();
  }
  sidebarCollapsed = loadSidebarCollapsed();
  applySidebarCollapsed();
  if (sidebarToggleBtn) {
    sidebarToggleBtn.onclick = () => toggleSidebarCollapsed();
  }
  themeMode = loadThemeMode();
  applyThemeMode(themeMode);
  setupSystemThemeListener();
  void refreshOpenAtLoginMenu();
  void refreshHotkeyMenu();

  window.addEventListener("load", () => {
    searchInput.focus();
  });

  // 拖放导入：JSON / Markdown / CSV
  let dragDepth = 0;
  const setDragActive = (active) => {
    document.body.classList.toggle("drag-import-active", active);
  };
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth += 1;
    setDragActive(true);
  });
  window.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragActive(false);
  });
  window.addEventListener("drop", async (e) => {
    dragDepth = 0;
    setDragActive(false);
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    if (isBlockingLayerOpen()) {
      showToast("请先关闭当前弹层，再拖入导入");
      return;
    }
    const file = e.dataTransfer.files[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const format = detectImportFormatFromPath(file.name || "");
      await importPromptsFromRaw(raw, format, "拖放导入");
    } catch (err) {
      await safeAlert(`拖放导入失败: ${err?.message || err}`);
    }
  });

  if (electronAPI?.onManageLayerBlocksHide) {
    electronAPI.onManageLayerBlocksHide(() => {
      // 管理弹层锁定期间 Alt+E / 点关闭 不藏窗，避免未保存草稿被 closeAllBlockingLayers 清掉。
      showToast("请先保存或关闭当前编辑/菜单", { duration: 2000 });
    });
  }

  if (electronAPI?.onPrepareQuit) {
    electronAPI.onPrepareQuit(() => {
      // 退出路径：尽量刷完 saveChain 再放行主进程 quit。
      void flushPendingSaves()
        .catch((err) => {
          console.error("prepare-quit flush failed", err);
        })
        .finally(() => {
          try {
            electronAPI.prepareQuitDone?.();
          } catch (err) {
            console.error("prepareQuitDone failed", err);
          }
        });
    });
  }

  if (electronAPI?.onFocusSearch) {
    electronAPI.onFocusSearch(() => {
      // 未保存编辑中：只收起菜单/右键，不进干净调用态，也不清草稿。
      if (isDirtyPromptModalOpen()) {
        closeAllBlockingLayers({ preserveDirtyPrompt: true });
        showToast("有未保存的编辑，请先保存或关闭", { duration: 2200 });
        try {
          focusModalPrimaryField();
        } catch {}
        return;
      }
      closeAllBlockingLayers({ preserveDirtyPrompt: false });
      const clearedSearch = clearSearchInput();
      // 干净调用态：不把上次分类筛选带进这次唤起。
      const filterReset = resetCategoryFilterToAll();
      // 使用后静默保存会改排序；仅脏时重绘，干净唤起更短。
      if (needsListRefresh || clearedSearch || filterReset) {
        renderAll();
      }
      // 唤起常在光标下：先锁定悬停改选，再落到第一名。
      armPointerHoverSelectAfterMove();
      // 每次唤起默认第一名：上次停在列表中部时，Enter 也不会偏离 1。
      selectFirstVisibleForCall();
      syncSearchClearButton();
      searchInput.focus();
      if (hasSearchInputChars()) {
        searchInput.select();
      }
      // 首次唤起时轻提示权限，不打断调用主路径。
      if (!a11yTipShown && electronAPI?.getPermissionDiagnostics) {
        a11yTipShown = true;
        void electronAPI
          .getPermissionDiagnostics()
          .then((diagnostics) => {
            if (diagnostics?.accessibilityTrusted === false) {
              showToast("自动粘贴需辅助功能权限 · 可在设置中查看", {
                duration: 4200,
              });
            }
          })
          .catch(() => {});
      }
    });
  }

  if (electronAPI?.onAutoBackup) {
    electronAPI.onAutoBackup((fileName) => {
      if (fileName) {
        showToast(`已自动备份：${fileName}`);
      } else {
        showToast("已自动备份");
      }
    });
  }
});
