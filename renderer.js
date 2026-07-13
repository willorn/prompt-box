const DEFAULT_PROMPTS = [
  {
    name: "文章润色专家",
    tag: "writing",
    content:
      "请将下面的文本润色为更通顺、更专业的中文，同时保留原意并给出三种不同风格（正式、亲切、技术性）的改写版本。",
    isPinned: false,
  },
  {
    name: "Tailwind 助手",
    tag: "coding",
    content:
      "根据下面的 UI 描述，生成对应的 Tailwind CSS 类名与简短示例 HTML，包含响应式样式和可访问性建议。",
    isPinned: false,
  },
  {
    name: "市场文案生成器",
    tag: "marketing",
    content:
      "为一款目标用户为职场人士的时间管理工具，生成三条不同角度的产品宣传文案（简洁、情感、功能导向），并包含一句 30 字以内的广告语。",
    isPinned: false,
  },
];

const electronAPI = window.electronAPI;

function assertElectron() {
  if (!electronAPI) {
    throw new Error("Electron API 不可用");
  }
}

function normalizePrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return null;
  const name = String(prompt.name ?? "").trim();
  const content = String(prompt.content ?? "").trim();
  if (!name || !content) return null;
  return {
    name,
    tag: typeof prompt.tag === "string" ? prompt.tag.trim() : "",
    content,
    isPinned: prompt.isPinned === true,
    useCount: Math.max(0, Number(prompt.useCount || 0)),
    lastUsedAt:
      typeof prompt.lastUsedAt === "string" ? prompt.lastUsedAt.trim() : "",
  };
}

function sanitizePromptList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => normalizePrompt(item)).filter(Boolean);
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
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

async function copyPromptForUse(text) {
  try {
    assertElectron();
    if (electronAPI?.copyPastePrompt) {
      return await electronAPI.copyPastePrompt(text);
    }
  } catch (err) {
    console.error("主进程复制粘贴失败，回退为仅复制", err);
  }

  const copied = await copyText(text);
  return { copied, pasted: false };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function toTimestamp(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function formatRelativeTime(value) {
  const timestamp = toTimestamp(value);
  if (!timestamp) return "最近未使用";
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return "刚刚使用";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / (24 * 60 * 60 * 1000))} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}

function getUsageSummary(item) {
  const count = Math.max(0, Number(item?.useCount || 0));
  return {
    useText: count > 0 ? `已使用 ${count} 次` : "尚未使用",
    lastUsedText: formatRelativeTime(item?.lastUsedAt),
  };
}

function normalizeTag(tag) {
  return typeof tag === "string" ? tag.trim() : "";
}

function comparePromptsForUse(a, b) {
  const lastUsedDiff = toTimestamp(b.lastUsedAt) - toTimestamp(a.lastUsedAt);
  if (lastUsedDiff !== 0) return lastUsedDiff;
  const useCountDiff = Math.max(0, Number(b.useCount || 0)) - Math.max(0, Number(a.useCount || 0));
  if (useCountDiff !== 0) return useCountDiff;
  return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
}


function setPreviewActionButtonLabel(button, label) {
  if (!button) return;
  const nextLabel = String(label ?? "").trim();
  const labelEl = button.querySelector(".preview-action-label");
  if (labelEl) {
    labelEl.textContent = nextLabel;
  } else {
    button.textContent = nextLabel;
  }
  button.setAttribute("aria-label", nextLabel);
  button.title = nextLabel;
}

function markPromptUsed(prompt) {
  if (!prompt || typeof prompt !== "object") return;
  prompt.useCount = Math.max(0, Number(prompt.useCount || 0)) + 1;
  prompt.lastUsedAt = new Date().toISOString();
}

document.addEventListener("DOMContentLoaded", () => {
  const navItemsContainer = document.getElementById("sidebar");
  const cardGrid = document.getElementById("cardGrid");
  const searchInput = document.getElementById("searchInput");
  const modal = document.getElementById("modalOverlay");
  const modalTitle = modal.querySelector("h2");
  const settingsBtn = document.getElementById("settingsBtn");

  const previewPanel = document.getElementById("previewPanel");
  const previewTitle = document.getElementById("previewTitle");
  const previewBody = document.getElementById("previewBody");
  const previewTag = document.getElementById("previewTag");
  const previewMode = document.getElementById("previewMode");
  const previewUsageStats = document.getElementById("previewUsageStats");
  const previewPin = document.getElementById("previewPin");
  const previewEdit = document.getElementById("previewEdit");
  const previewDelete = document.getElementById("previewDelete");

  const addTagBtn = document.getElementById("addTagBtn");
  const tagInput = document.getElementById("newTag");
  const tagDropdown = document.getElementById("tagDropdown");

  const addBtn = document.getElementById("addBtn");
  const cancelBtn = document.getElementById("cancelBtn");
  const saveBtn = document.getElementById("saveBtn");
  const menuImport = document.getElementById("menuImport");
  const menuExport = document.getElementById("menuExport");
  const menuWebdav = document.getElementById("menuWebdav");
  const menuHiddenTags = document.getElementById("menuHiddenTags");
  const menuPermissions = document.getElementById("menuPermissions");
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
  let contextMenuTargetIndex = null;
  let renameTagOriginal = null;

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
    const sanitized = sanitizeTagList(tags);
    if (!electronAPI?.setHiddenTags) {
      hiddenTags = sanitized;
      return hiddenTags;
    }
    try {
      const saved = await electronAPI.setHiddenTags(sanitized);
      hiddenTags = sanitizeTagList(saved);
    } catch (err) {
      console.error("保存隐藏分类失败", err);
      hiddenTags = sanitized;
    }
    return hiddenTags;
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
  }

  function closeRenameTagModal() {
    if (!renameTagOverlay) return;
    renameTagOverlay.style.display = "none";
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

    allPrompts = updatedPrompts;

    if (hiddenTags.includes(normalizedOld)) {
      let updatedHidden = hiddenTags.filter((tag) => tag !== normalizedOld);
      if (normalizedNew && !updatedHidden.includes(normalizedNew)) {
        updatedHidden.push(normalizedNew);
      }
      await persistHiddenTags(updatedHidden);
    }

    await saveData();
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

  if (settingsBtn) {
    settingsBtn.onclick = (e) => {
      e.stopPropagation();
      if (!moreMenu) return;
      moreMenu.style.display = moreMenu.style.display === "block" ? "none" : "block";
    };
  }

  document.addEventListener("click", (e) => {
    if (!moreMenu) return;
    if (e.target && moreMenu.contains(e.target)) return;
    if (settingsBtn && (e.target === settingsBtn || settingsBtn.contains(e.target))) return;
    moreMenu.style.display = "none";
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
    if (!electronAPI?.setWebdavConfig) return;
    const config = collectWebdavConfig();
    await electronAPI.setWebdavConfig(config);
    return config;
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
  }

  function closeWebdavModal() {
    if (!webdavOverlay) return;
    webdavOverlay.style.display = "none";
  }

  function openHiddenTagsModal() {
    if (!hiddenTagsOverlay) return;
    renderHiddenTagsList();
    hiddenTagsOverlay.style.display = "flex";
  }

  function closeHiddenTagsModal() {
    if (!hiddenTagsOverlay) return;
    hiddenTagsOverlay.style.display = "none";
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
    await persistHiddenTags(selected);
    closeHiddenTagsModal();
    renderAll();
    showToast("隐藏分类设置已更新");
  }

  function showToast(message = "已复制到剪贴板") {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.style.display = "block";
    toast.style.opacity = "1";

    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => {
        toast.style.display = "none";
      }, 300);
    }, 1500);
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
    contextMenuTargetIndex = item.originalIndex;

    // 更新置顶按钮文字
    if (contextPinText) {
      contextPinText.textContent = item.isPinned ? "取消置顶" : "置顶";
    }

    // 定位菜单
    const x = Math.min(e.clientX, window.innerWidth - 160);
    const y = Math.min(e.clientY, window.innerHeight - 120);
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.style.display = "block";
  }

  function hideContextMenu() {
    if (contextMenu) {
      contextMenu.style.display = "none";
    }
    contextMenuTargetIndex = null;
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
            data.isPinned = !data.isPinned;
            await saveData();
            showToast(data.isPinned ? "已置顶" : "已取消置顶");
            break;
          case "edit":
            openEditModal(index);
            break;
          case "delete":
            if (confirm(`确定要删除 "${data.name}" 吗？`)) {
              allPrompts.splice(index, 1);
              await saveData();
              showToast("已删除");
            }
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
  }

  function openEditModal(index) {
    const data = allPrompts[index];
    if (!data) return;
    editingIndex = index;
    selectCard(index);
    const nameInput = document.getElementById("newName");
    const contentInput = document.getElementById("newContent");
    if (nameInput) nameInput.value = data.name;
    if (tagInput) tagInput.value = data.tag;
    if (contentInput) contentInput.value = data.content;
    if (modalTitle) modalTitle.innerText = "编辑提示词";
    if (modal) modal.style.display = "flex";
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
    if (previewTitle) previewTitle.textContent = "选择一条提示词";
    if (previewBody) {
      previewBody.textContent =
        "单击卡片立即使用；右键或右侧按钮可置顶、编辑、删除。";
    }
    if (previewTag) previewTag.textContent = "未选择";
    if (previewMode) {
      previewMode.textContent = "";
    }
    if (previewUsageStats) {
      previewUsageStats.textContent = "暂无使用记录";
    }
    if (previewPin) {
      setPreviewActionButtonLabel(previewPin, "置顶");
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
    if (previewTag) previewTag.textContent = normalizeTag(item.tag) || "默认";
    if (previewMode) {
      previewMode.textContent = "";
    }
    if (previewUsageStats) {
      previewUsageStats.textContent = `${useText} · ${lastUsedText}`;
    }
    if (previewPin) {
      setPreviewActionButtonLabel(previewPin, item.isPinned ? "取消置顶" : "置顶");
      previewPin.disabled = false;
    }
    if (previewEdit) previewEdit.disabled = false;
    if (previewDelete) previewDelete.disabled = false;
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

  function setActiveCardElement(nextCard) {
    if (lastActiveCardEl && lastActiveCardEl !== nextCard) {
      lastActiveCardEl.classList.remove("active-card");
    }
    if (nextCard) {
      nextCard.classList.add("active-card");
    }
    // Fallback cleanup if DOM was re-rendered and lastActiveCardEl is stale
    if (!nextCard || !nextCard.isConnected) {
      document.querySelectorAll(".card.active-card").forEach((el) => {
        if (el !== nextCard) el.classList.remove("active-card");
      });
    } else {
      document.querySelectorAll(".card.active-card").forEach((el) => {
        if (el !== nextCard) el.classList.remove("active-card");
      });
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
    if (selectedIndex === originalIndex && fromHover) return;
    selectedIndex = originalIndex;
    const nextCard =
      document.querySelector(`.card[data-original-index="${originalIndex}"]`) || null;
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
    const cardTop = card.offsetTop;
    const cardBottom = cardTop + card.offsetHeight;
    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + scroller.clientHeight;
    const pad = 12;

    if (cardTop < viewTop + pad) {
      scroller.scrollTop = Math.max(0, cardTop - pad);
    } else if (cardBottom > viewBottom - pad) {
      scroller.scrollTop = cardBottom - scroller.clientHeight + pad;
    }
  }

  function getVisibleCards() {
    return Array.from(document.querySelectorAll(".card"));
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

  function isBlockingLayerOpen() {
    return (
      contextMenu?.style.display === "block" ||
      moreMenu?.style.display === "block" ||
      modal?.style.display === "flex" ||
      pasteConfigOverlay?.style.display === "flex" ||
      copyConfigOverlay?.style.display === "flex" ||
      renameTagOverlay?.style.display === "flex" ||
      hiddenTagsOverlay?.style.display === "flex" ||
      webdavOverlay?.style.display === "flex"
    );
  }

  async function usePromptAtIndex(index, card = null) {
    const item = allPrompts[index];
    if (!item) return null;
    const result = await copyPromptForUse(item.content);
    if (!result?.copied) {
      console.error("复制失败");
      showToast("复制失败，请手动复制");
      return result;
    }

    markPromptUsed(item);
    await saveData();

    if (card) {
      card.style.boxShadow = "0 0 0 3px rgba(79, 140, 255, 0.14), 0 16px 34px rgba(15, 23, 42, 0.1)";
      setTimeout(() => (card.style.boxShadow = item.isPinned ? "0 14px 30px rgba(15, 23, 42, 0.08)" : ""), 500);
      card.style.backgroundColor = "#edf4ff";
      setTimeout(() => {
        card.style.backgroundColor = item.isPinned ? "#f6faff" : "";
      }, 200);
    }

    if (result.pasted) {
      showToast("已粘贴到当前输入位置");
    } else if (result.requiresAccessibilityPermission) {
      showToast("已复制，请先授予辅助功能权限");
    } else if (result.requiresAutomationPermission) {
      showToast("已复制，请允许 Electron 控制 System Events");
      void openAutomationSettings();
    } else {
      showToast("已复制，未自动粘贴");
    }

    if (!result.pasted) {
      closeCurrentWindowSilently();
    }
    selectCard(index);
    return result;
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
        document
          .querySelectorAll(".nav-item")
          .forEach((nav) => nav.classList.remove("active"));
        item.classList.add("active");
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

  async function saveData() {
    allPrompts = sanitizePromptList(allPrompts);
    try {
      await persistPrompts(allPrompts);
    } catch (err) {
      console.error("保存失败", err);
    }
    renderAll();
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
    const pinnedItems = [];
    const recentItems = [];
    const regularItems = [];

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

    displayList.forEach((item) => {
      const normalizedTag = normalizeTag(item.tag);
      const matchesSearch =
        item.name.toLowerCase().includes(term) ||
        item.content.toLowerCase().includes(term) ||
        normalizedTag.toLowerCase().includes(term);
      const matchesCategory =
        activeFilter === "all"
          ? !isTagHidden(normalizedTag)
          : normalizedTag === activeFilter;

      if (matchesSearch && matchesCategory) {
        visibleCount += 1;
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
        card.addEventListener("mouseenter", () => {
          if (isKeyboardNavigating()) return;
          selectCard(item.originalIndex, true, { animate: false });
        });
        card.addEventListener("focus", () => {
          selectCard(item.originalIndex, true, { animate: false });
        });
        card.addEventListener("click", async () => {
          selectCard(item.originalIndex);
          card.focus({ preventScroll: true });
          await handleUsePrompt();
        });

        const handleUsePrompt = async () => usePromptAtIndex(item.originalIndex, card);

        // Arrow navigation is handled once at document level to avoid double-step jumps.
        card.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            selectCard(item.originalIndex);
            handleUsePrompt();
          }
        };

        card.innerHTML = `
          <div class="card-header">
            <div class="card-content">
              <div class="card-title-row">
                <div class="card-title">${escapeHtml(item.name)}</div>
                <span class="card-tag">${escapeHtml(normalizedTag || "默认")}</span>
              </div>
              <div class="card-body">${escapeHtml(item.content)}</div>
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

        if (item.isPinned) {
          pinnedItems.push(card);
        } else if (toTimestamp(item.lastUsedAt) > 0) {
          recentItems.push({ card, item });
        } else {
          regularItems.push(card);
        }
        visibleIndices.push(item.originalIndex);
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
      const pinnedList = createSection("置顶");
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

    if (visibleCount === 0) {
      const isEmpty = allPrompts.length === 0;
      cardGrid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">${isEmpty ? "✨" : "🔍"}</div>
          <div class="empty-state-title">${escapeHtml(
            isEmpty ? "欢迎使用 PromptBox" : "没有匹配结果",
          )}</div>
          <div class="empty-state-text">${escapeHtml(
            isEmpty
              ? "点左侧「新增」添加第一条提示词，即可开始使用。"
              : "试试更短的关键词、切换分类，或在设置里检查是否有分类被隐藏。",
          )}</div>
          ${isEmpty ? `
          <div class="empty-state-actions">
            <button class="empty-state-btn primary" onclick="document.getElementById('addBtn').click()">
              新增提示词
            </button>
          </div>
          <div class="empty-state-shortcuts">
            <span>快捷键：</span>
            <kbd>↑</kbd><kbd>↓</kbd> 选择 · 
            <kbd>↵</kbd> 使用 · 
            <kbd>⌘</kbd> + <kbd>,</kbd> 设置
          </div>
          ` : ""}
        </div>
      `;
      clearPreview();
      return;
    }

    if (visibleIndices.length === 0) {
      clearPreview();
    } else if (!visibleIndices.includes(selectedIndex)) {
      selectCard(visibleIndices[0]);
    }

  }

  function clearSearchInput({ focus = false } = {}) {
    const hadValue = searchInput.value.length > 0;
    if (hadValue) {
      searchInput.value = "";
      renderCards();
    }
    if (focus) {
      searchInput.focus();
    }
    return hadValue;
  }

  searchInput.addEventListener("input", () => {
    renderCards();
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchInput.value) {
      e.preventDefault();
      e.stopPropagation();
      clearSearchInput({ focus: true });
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const firstCard = document.querySelector(".card");
      if (firstCard) {
        firstCard.focus({ preventScroll: true });
        selectCard(Number(firstCard.dataset.originalIndex), false, { instant: true });
        ensureCardVisible(firstCard);
        e.preventDefault();
      }
    }
  });

  saveBtn.onclick = async () => {
    const name = document.getElementById("newName").value.trim();
    const tag = document.getElementById("newTag").value.trim();
    const content = document.getElementById("newContent").value.trim();

    if (!name || !content) return alert("名称和内容不能为空");

    if (editingIndex !== null) {
      allPrompts[editingIndex] = {
        ...allPrompts[editingIndex],
        name,
        tag,
        content,
      };
    } else {
      allPrompts.push({
        name,
        tag,
        content,
        isPinned: false,
        useCount: 0,
        lastUsedAt: "",
      });
    }

    modal.style.display = "none";
    await saveData();
    resetForm();
  };

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

  addBtn.onclick = () => {
    resetForm();
    modal.style.display = "flex";
  };

  if (addTagBtn) {
    addTagBtn.onclick = () => {
      resetForm();
      modal.style.display = "flex";
      if (tagInput) {
        requestAnimationFrame(() => {
          tagInput.focus();
          tagInput.select();
        });
      }
      showToast("输入新标签名称并保存提示词，即可创建分类");
    };
  }

  cancelBtn.onclick = () => (modal.style.display = "none");

  if (menuExport) menuExport.onclick = async () => {
    try {
      const content = JSON.stringify(allPrompts, null, 2);
      assertElectron();
      const result = await electronAPI.exportPrompts(content);
      if (!result?.canceled && result?.filePath) {
        showToast(`已导出：${result.filePath.split(/[\\/]/).pop()}`);
      }
    } catch (err) {
      if (!String(err).includes("取消")) {
        alert(`导出失败: ${err}`);
      }
    }
    if (moreMenu) moreMenu.style.display = "none";
  };

  if (menuHiddenTags) {
    menuHiddenTags.onclick = () => {
      openHiddenTagsModal();
      if (moreMenu) moreMenu.style.display = "none";
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
        "2. 全局快捷键 Alt+E 在部分机器上也可能依赖辅助功能权限。",
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

      alert(detail);
      if (accessibilityTrusted === false) {
        await openAccessibilitySettings();
      } else {
        await openAutomationSettings();
      }
      if (moreMenu) moreMenu.style.display = "none";
    };
  }

  if (menuWebdav) menuWebdav.onclick = () => {
    (async () => {
      openWebdavModal();
      if (moreMenu) moreMenu.style.display = "none";
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
      const parsed = JSON.parse(result.raw);
      const prompts = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.prompts) ? parsed.prompts : null;
      if (!prompts) {
        alert("文件格式错误：必须是提示词数组，或包含 prompts 数组的备份文件");
        return;
      }
      const importedPrompts = sanitizePromptList(prompts);
      if (prompts.length > 0 && importedPrompts.length === 0) {
        alert("导入失败：文件中的提示词格式无效");
        return;
      }
      allPrompts = importedPrompts;
      selectedIndex = null;
      await saveData();
      showToast("导入成功");
    } catch (err) {
      if (!String(err).includes("取消")) {
        alert(`导入失败: ${err}`);
      }
    }
    if (moreMenu) moreMenu.style.display = "none";
  };

  if (previewEdit) {
    previewEdit.onclick = () => {
      if (selectedIndex === null) return;
      openEditModal(selectedIndex);
    };
  }

  if (previewPin) {
    previewPin.onclick = async () => {
      if (selectedIndex === null || !allPrompts[selectedIndex]) return;
      allPrompts[selectedIndex].isPinned = !allPrompts[selectedIndex].isPinned;
      await saveData();
      showToast(allPrompts[selectedIndex]?.isPinned ? "已置顶" : "已取消置顶");
    };
  }

  if (previewDelete) {
    previewDelete.onclick = async () => {
      if (selectedIndex === null) return;
      const item = allPrompts[selectedIndex];
      if (!item) return;
      if (!confirm(`确定删除 "${item.name}" 吗？`)) return;
      allPrompts.splice(selectedIndex, 1);
      await saveData();
      showToast("已删除");
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
        await saveWebdavConfig();
        await loadWebdavBackups();
        showToast("已刷新");
      } catch (err) {
        alert(`刷新失败: ${err}`);
      }
    };
  }

  if (webdavTest) {
    webdavTest.onclick = async () => {
      try {
        await saveWebdavConfig();
        await electronAPI.testWebdav();
        showToast("WebDAV 连接成功");
      } catch (err) {
        alert(`连接失败: ${err}`);
      }
    };
  }

  if (webdavBackup) {
    webdavBackup.onclick = async () => {
      try {
        await saveWebdavConfig();
        const result = await electronAPI.backupWebdav();
        await loadWebdavBackups();
        if (result?.fileName) {
          showToast(`已备份：${result.fileName}`);
        } else {
          showToast("已备份");
        }
      } catch (err) {
        alert(`备份失败: ${err}`);
      }
    };
  }

  if (webdavRestore) {
    webdavRestore.onclick = async () => {
      try {
        await saveWebdavConfig();
        if (!confirm("将从 WebDAV 恢复，当前本地内容将被覆盖。继续吗？")) {
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
          alert("暂无可恢复的云端备份，请先刷新列表或立即备份。");
          return;
        }
        allPrompts = await loadPrompts();
        renderAll();
        showToast(`已恢复 ${result?.promptsCount ?? 0} 条`);
      } catch (err) {
        alert(`恢复失败: ${err}`);
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
  }

  function closeCopyConfigModal() {
    if (copyConfigOverlay) copyConfigOverlay.style.display = "none";
  }

  // Paste Config Modal Functions
  function openPasteConfigModal() {
    if (!pasteConfigOverlay) return;
    if (pasteConfigText) pasteConfigText.value = "";
    pasteConfigOverlay.style.display = "flex";
  }

  function closePasteConfigModal() {
    if (pasteConfigOverlay) pasteConfigOverlay.style.display = "none";
  }

  async function applyPastedConfig() {
    try {
      const raw = pasteConfigText?.value?.trim();
      if (!raw) {
        alert("请粘贴配置 JSON");
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
      await saveWebdavConfig();
      closePasteConfigModal();
      showToast("配置已应用");
    } catch (err) {
      alert(`解析失败: ${err}`);
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
        showToast("已复制到剪贴板");
        closeCopyConfigModal();
      } catch (err) {
        alert(`复制失败: ${err}`);
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
      if (contextMenu?.style.display === "block") {
        hideContextMenu();
        return;
      }
      if (moreMenu?.style.display === "block") {
        moreMenu.style.display = "none";
        return;
      }
      if (modal?.style.display === "flex") {
        modal.style.display = "none";
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
      closeCurrentWindowSilently();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      if (moreMenu) {
        moreMenu.style.display = moreMenu.style.display === "block" ? "none" : "block";
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
      if (!isBlockingLayerOpen() && (!isTypingTarget(e.target) || isSearchFocused)) {
        const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
        const moved = focusAdjacentCard(step);
        if (moved) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

    if (e.key === "/" && !isTypingTarget(e.target)) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  if (searchInput) {
    searchInput.placeholder = "搜索提示词";
  }
  if (settingsBtn) {
    settingsBtn.title = "设置";
  }

  window.addEventListener("load", () => {
    searchInput.focus();
  });

  if (electronAPI?.onFocusSearch) {
    electronAPI.onFocusSearch(() => {
      clearSearchInput();
      searchInput.focus();
      if (searchInput.value) {
        searchInput.select();
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
