import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  screen,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { execFile } from "child_process";
import Store from "electron-store";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { createClient } from "webdav";
import {
  sanitizePromptList,
  promptIdentityKey,
  getDefaultSamplePrompts,
} from "./lib/prompt-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 兼容打包后的路径
function getAssetPath(...paths) {
  // 打包后使用 app.getAppPath() 获取应用根目录
  if (app.isPackaged) {
    return path.join(app.getAppPath(), ...paths);
  }
  return path.join(__dirname, ...paths);
}

function getExtraResourcePath(...paths) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...paths);
  }
  return path.join(__dirname, ...paths);
}

const store = new Store({
  name: "window-state",
  defaults: {
    // 与 DEFAULT_WINDOW_BOUNDS 一致：首次启动更紧凑，服务调用层密度
    bounds: { width: 860, height: 600, x: undefined, y: undefined },
    isMaximized: false,
  },
});

const DEFAULT_WINDOW_BOUNDS = { width: 860, height: 600 };
const MIN_WINDOW_WIDTH = 720;
const MIN_WINDOW_HEIGHT = 520;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getVisibleDisplayForBounds(bounds) {
  try {
    const center = {
      x: Math.round((bounds.x || 0) + (bounds.width || DEFAULT_WINDOW_BOUNDS.width) / 2),
      y: Math.round((bounds.y || 0) + (bounds.height || DEFAULT_WINDOW_BOUNDS.height) / 2),
    };
    return screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay();
  } catch {
    return screen.getPrimaryDisplay();
  }
}

function sanitizeWindowBounds(rawBounds) {
  const base = {
    width: Number(rawBounds?.width) || DEFAULT_WINDOW_BOUNDS.width,
    height: Number(rawBounds?.height) || DEFAULT_WINDOW_BOUNDS.height,
    x: Number.isFinite(rawBounds?.x) ? Number(rawBounds.x) : undefined,
    y: Number.isFinite(rawBounds?.y) ? Number(rawBounds.y) : undefined,
  };

  const display = getVisibleDisplayForBounds(base);
  const work = display.workArea;
  const width = clamp(base.width, MIN_WINDOW_WIDTH, work.width);
  const height = clamp(base.height, MIN_WINDOW_HEIGHT, work.height);

  let x = base.x;
  let y = base.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    x = Math.round(work.x + (work.width - width) / 2);
    y = Math.round(work.y + (work.height - height) / 2);
  } else {
    x = clamp(x, work.x, work.x + work.width - width);
    y = clamp(y, work.y, work.y + work.height - height);
  }

  return { x, y, width, height };
}

function getSavedWindowState() {
  const bounds = sanitizeWindowBounds(store.get("bounds"));
  const isMaximized = store.get("isMaximized") === true;
  return { bounds, isMaximized };
}
const dataStore = new Store({
  name: "prompt-box-data",
});

const MAX_SAFETY_SNAPSHOTS = 5;

function promptsIdentitySignature(list) {
  return sanitizePromptList(list)
    .map((item) => promptIdentityKey(item))
    .sort()
    .join("\n");
}

function getSafetySnapshots() {
  const raw = dataStore.get("safetySnapshots");
  return Array.isArray(raw) ? raw : [];
}

function pushSafetySnapshot(prompts, { force = false } = {}) {
  const list = sanitizePromptList(prompts);
  if (!list.length && !force) return false;
  const fingerprint = promptsIdentitySignature(list);
  const snaps = getSafetySnapshots();
  const latest = snaps[0];
  if (!force && latest?.fingerprint === fingerprint) return false;
  // 仅使用计数变化时跳过，避免每次粘贴都堆快照。
  if (
    !force &&
    latest &&
    latest.count === list.length &&
    latest.fingerprint === fingerprint
  ) {
    return false;
  }
  snaps.unshift({
    at: new Date().toISOString(),
    count: list.length,
    fingerprint,
    prompts: list,
  });
  dataStore.set("safetySnapshots", snaps.slice(0, MAX_SAFETY_SNAPSHOTS));
  return true;
}

const webdavStore = new Store({
  name: "prompt-box-webdav",
  defaults: {
    url: "",
    username: "",
    password: "",
    directory: "prompt-box-backups",
    autoBackupEnabled: true,
    intervalDays: 3,
    lastAutoBackupAt: 0,
  },
});

function sanitizeHiddenTagInput(input) {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : [input];
  return Array.from(
    new Set(
      arr
        .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
        .filter((tag) => tag.length > 0),
    ),
  );
}

function getHiddenTagsFromStore() {
  const raw = dataStore.get("hiddenTags");
  return sanitizeHiddenTagInput(raw);
}

function setHiddenTagsInStore(tags) {
  const sanitized = sanitizeHiddenTagInput(tags);
  dataStore.set("hiddenTags", sanitized);
  return sanitized;
}

let mainWindow = null;
let tray = null;
let isHiddenOffscreen = false;
let isQuitting = false;
// 唤起前记录外部前台应用，粘贴时优先回到它。
let lastPasteTargetApp = "";
// 同一次唤起记录的目标 pid；进程仍在时优先按 pid 激活，避免本地化显示名不一致。
let lastPasteTargetPid = 0;
// 实际注册成功的全局快捷键（冲突时可能回退）。
let activeGlobalHotkey = "Alt+E";
// 每个会话最多触发一次系统辅助功能授权提示，避免每次粘贴都阻塞。
let accessibilityPromptTriggered = false;
// 粘贴成功后恢复用户原剪贴板的定时器；再次粘贴时取消，避免连续粘贴被抢回。
let clipboardRestoreTimer = null;
// 待恢复的剪贴板内容；退出时若仍占着本次提示词则立即还回。
let clipboardRestorePending = null;
let blurHideTimer = null;
let suppressBlurHideUntil = 0;
// 编辑/同步等管理弹层打开时锁定，避免失焦隐藏清掉未保存草稿。
let blurHideLocked = false;
// 退出前先让渲染进程刷完 saveChain，再真正 quit。
let allowQuit = false;
let quitFlushInProgress = false;
const prefsStore = new Store({
  name: "prompt-box-prefs",
  defaults: {
    backgroundReadyNotified: false,
    lastSuccessfulPasteTarget: "",
    preferredGlobalHotkey: "Alt+E",
  },
});

function getOpenAtLogin() {
  try {
    const settings = app.getLoginItemSettings();
    return settings?.openAtLogin === true;
  } catch {
    return false;
  }
}

function setOpenAtLogin(enabled) {
  const openAtLogin = enabled === true;
  try {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: true,
    });
  } catch (error) {
    console.error("setLoginItemSettings failed", error);
    throw error;
  }
  return getOpenAtLogin();
}

function maybeNotifyBackgroundReady() {
  try {
    if (prefsStore.get("backgroundReadyNotified") === true) return;
    if (!Notification.isSupported()) {
      prefsStore.set("backgroundReadyNotified", true);
      return;
    }
    const notification = new Notification({
      title: "PromptBox 已在后台运行",
      body: `按 ${activeGlobalHotkey || "Alt+E"} 呼出，再按一次隐藏。可在托盘图标菜单管理。`,
      silent: true,
    });
    notification.show();
    prefsStore.set("backgroundReadyNotified", true);
  } catch (error) {
    console.error("background ready notify failed", error);
  }
}


function suppressBlurHide(ms = 1500) {
  const duration = Math.max(0, Number(ms) || 0);
  suppressBlurHideUntil = Date.now() + duration;
  if (blurHideTimer) {
    clearTimeout(blurHideTimer);
    blurHideTimer = null;
  }
}

function setBlurHideLocked(locked) {
  blurHideLocked = locked === true;
  if (blurHideLocked && blurHideTimer) {
    clearTimeout(blurHideTimer);
    blurHideTimer = null;
  }
  return blurHideLocked;
}

function scheduleHideOnBlur() {
  if (isQuitting || isHiddenOffscreen) return;
  if (blurHideLocked) return;
  if (Date.now() < suppressBlurHideUntil) return;
  if (blurHideTimer) clearTimeout(blurHideTimer);
  blurHideTimer = setTimeout(() => {
    blurHideTimer = null;
    if (isQuitting || isHiddenOffscreen) return;
    if (blurHideLocked) return;
    if (Date.now() < suppressBlurHideUntil) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isFocused()) return;
    // 失焦即退场：调用层不应在后台占着屏幕。
    hideMainWindow();
  }, 160);
}

function keepDockHidden() {
  if (process.platform === "darwin") {
    app.dock?.hide();
  }
}

function getAppIconPath() {
  const candidates = [
    getExtraResourcePath("assets", "icon.icns"),
    getExtraResourcePath("assets", "icon.png"),
    getAssetPath("assets", "icon.icns"),
    getAssetPath("assets", "icon.png"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function createMainWindow() {
  const { bounds, isMaximized } = getSavedWindowState();
  const iconPath = getAppIconPath();

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    // 菜单栏调用层：默认不抢前台，等 Alt+E / 托盘再显示
    show: false,
    skipTaskbar: process.platform === "darwin",
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: getAssetPath("preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(getAssetPath("index.html"));

  if (isMaximized) {
    mainWindow.maximize();
  }

  // 调用层窗口不打开外链/新窗，也不允许导航离开本地页面。
  try {
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  } catch {}
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const target = String(url || "");
    if (!target.startsWith("file:")) {
      event.preventDefault();
    }
  });

  // 渲染进程崩溃/被杀时自动重载，避免托盘还在但窗口白屏假死。
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("render-process-gone", details?.reason || details);
    if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.reload();
    } catch (error) {
      console.error("reload after render-process-gone failed", error);
    }
  });
  mainWindow.webContents.on("unresponsive", () => {
    console.error("renderer unresponsive");
  });

  // 崩溃重载或首次完成加载：若窗口当前可见，回到干净调用态（隐藏待命时不打扰）。
  mainWindow.webContents.on("did-finish-load", () => {
    if (isQuitting || !mainWindow || mainWindow.isDestroyed() || isHiddenOffscreen) return;
    try {
      if (!mainWindow.isVisible()) return;
    } catch {
      return;
    }
    try {
      mainWindow.webContents.send("focus-search");
    } catch (error) {
      console.error("focus-search after did-finish-load failed", error);
    }
  });

  mainWindow.once("ready-to-show", () => {
    // 保持后台待命，避免开机/启动时突然弹窗打断当前工作。
    hideMainWindow();
    maybeNotifyBackgroundReady();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    requestHideMainWindow();
  });

  mainWindow.on("blur", () => {
    scheduleHideOnBlur();
  });
  mainWindow.on("focus", () => {
    if (blurHideTimer) {
      clearTimeout(blurHideTimer);
      blurHideTimer = null;
    }
  });

  let saveTimer = null;
  const scheduleSaveWindowState = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveWindowState();
    }, 120);
  };
  mainWindow.on("resize", scheduleSaveWindowState);
  mainWindow.on("move", scheduleSaveWindowState);
  mainWindow.on("maximize", saveWindowState);
  mainWindow.on("unmaximize", saveWindowState);
}

function saveWindowState() {
  if (!mainWindow || isHiddenOffscreen || mainWindow.isDestroyed()) return;
  // Only persist on-screen geometry so hide-offscreen never overwrites real bounds.
  const maximized = mainWindow.isMaximized();
  store.set("isMaximized", maximized);
  try {
    // Prefer normal bounds so restore after maximize is correct.
    const raw = maximized && typeof mainWindow.getNormalBounds === "function"
      ? mainWindow.getNormalBounds()
      : mainWindow.getBounds();
    store.set("bounds", sanitizeWindowBounds(raw));
  } catch {
    if (!maximized) {
      store.set("bounds", sanitizeWindowBounds(mainWindow.getBounds()));
    }
  }
}

function escapeAppleScriptString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function isSelfAppName(name) {
  const value = String(name || "").trim();
  if (!value) return true;
  const selfNames = new Set(
    [app.getName(), "PromptBox", "Electron", "prompt-box-electron"].filter(Boolean),
  );
  if (selfNames.has(value)) return true;
  // 开发模式下还可能是 Electron Helper 一类进程名。
  return /electron/i.test(value) && !/cursor/i.test(value);
}

function runExecFile(file, args, timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || error).trim()));
          return;
        }
        resolve(String(stdout || ""));
      },
    );
  });
}

function parseLsappinfoPid(raw) {
  const text = String(raw || "");
  const match = text.match(/pid"?\s*=\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function parseLsappinfoDisplayName(raw) {
  const text = String(raw || "");
  const match = text.match(/LSDisplayName"?\s*=\s*"([^"]*)"/i);
  return match ? String(match[1] || "").trim() : "";
}

async function getProcessNameByPid(pid) {
  const id = Number(pid);
  if (!Number.isFinite(id) || id <= 0) return "";
  // 优先 ps：毫秒级，且 basename 通常就是 System Events 进程名（Finder/Google Chrome…）
  try {
    const comm = (await runExecFile("ps", ["-p", String(id), "-o", "comm="], 400)).trim();
    const base = path.basename(comm);
    if (base) return base;
  } catch {}
  try {
    const out = await runOsascript([
      'tell application "System Events"',
      `name of first process whose unix id is ${id}`,
      "end tell",
    ]);
    return String(out || "").trim();
  } catch {
    return "";
  }
}

async function getFrontmostAppInfoFast() {
  // 唤起热路径：两次 lsappinfo 拿 pid+显示名；不默认再跑 ps/System Events。
  // 粘贴激活仍会用 pid 校验现场进程名，失败再回退进程名/application activate。
  const asn = (await runExecFile("lsappinfo", ["front"], 280)).trim();
  if (!asn) return { name: "", pid: 0 };
  const infoRaw = await runExecFile(
    "lsappinfo",
    ["info", "-only", "pid,name", asn],
    280,
  );
  const pid = parseLsappinfoPid(infoRaw);
  let name = parseLsappinfoDisplayName(infoRaw);
  if (pid > 0 && !name) {
    // 少数环境 info 无显示名时，才补一次 ps basename。
    name = await getProcessNameByPid(pid);
  }
  if (!name && !pid) return { name: "", pid: 0 };
  return { name, pid: pid || 0 };
}

async function getFrontmostAppInfo() {
  if (process.platform !== "darwin") return { name: "", pid: 0 };
  try {
    const fast = await getFrontmostAppInfoFast();
    if (fast.pid || fast.name) return fast;
  } catch (error) {
    console.error("getFrontmostAppInfoFast failed", error);
  }
  // 慢路径兜底：System Events frontmost（部分环境 lsappinfo 不可用）
  try {
    const out = await runOsascript([
      'tell application "System Events"',
      "name of first application process whose frontmost is true",
      "end tell",
    ]);
    return { name: String(out || "").trim(), pid: 0 };
  } catch (error) {
    console.error("getFrontmostAppName failed", error);
    return { name: "", pid: 0 };
  }
}

async function getFrontmostAppName() {
  const info = await getFrontmostAppInfo();
  return info.name || "";
}

async function rememberPasteTargetApp({ fastOnly = false } = {}) {
  if (process.platform !== "darwin") return;
  let info = { name: "", pid: 0 };
  if (fastOnly) {
    // 唤起路径：只走 lsappinfo 快路径，绝不被 System Events 拖住显示。
    try {
      info = await getFrontmostAppInfoFast();
    } catch (error) {
      console.error("rememberPasteTargetApp fast path failed", error);
      info = { name: "", pid: 0 };
    }
  } else {
    info = await getFrontmostAppInfo();
  }
  if (!info.name || isSelfAppName(info.name)) {
    // 本次没记到外部前台：清掉会话目标与 pid，避免沿用过期进程。
    // 粘贴仍可回退 lastSuccessfulPasteTarget（仅名称，无 pid）。
    lastPasteTargetApp = "";
    lastPasteTargetPid = 0;
    return;
  }
  lastPasteTargetApp = info.name;
  lastPasteTargetPid = Number(info.pid) || 0;
}

function placeBoundsOnCursorDisplay(bounds, isMaximized) {
  if (isMaximized || !bounds) return bounds;
  try {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const work = display?.workArea;
    if (!work) return bounds;

    const centerX = Number(bounds.x) + Number(bounds.width) / 2;
    const centerY = Number(bounds.y) + Number(bounds.height) / 2;
    const onDisplay =
      centerX >= work.x &&
      centerX <= work.x + work.width &&
      centerY >= work.y &&
      centerY <= work.y + work.height;
    if (onDisplay) return bounds;

    // 记忆位置不在当前光标显示器时，挪到光标所在屏中央，减少“唤起来却看不见”。
    return sanitizeWindowBounds({
      width: bounds.width,
      height: bounds.height,
      x: Math.round(work.x + (work.width - bounds.width) / 2),
      y: Math.round(work.y + (work.height - bounds.height) / 2),
    });
  } catch {
    return bounds;
  }
}

function ensureMainWindowOnVisibleDisplay() {
  // 拔掉显示器 / 分辨率变化后，把仍可见的窗口拽回可用工作区。
  if (!mainWindow || mainWindow.isDestroyed() || isHiddenOffscreen) return;
  try {
    if (mainWindow.isMaximized()) return;
    const current = mainWindow.getBounds();
    const next = sanitizeWindowBounds(current);
    if (
      next.x !== current.x ||
      next.y !== current.y ||
      next.width !== current.width ||
      next.height !== current.height
    ) {
      mainWindow.setBounds(next, false);
    }
  } catch (error) {
    console.error("ensureMainWindowOnVisibleDisplay failed", error);
  }
}

async function showMainWindow() {
  if (!mainWindow) return;

  // 记前台与窗口几何准备并行，但必须在 show 前完成记忆，避免记到自己。
  const rememberPromise = rememberPasteTargetApp({ fastOnly: true });

  const saved = getSavedWindowState();
  const isMaximized = saved.isMaximized;
  const bounds = placeBoundsOnCursorDisplay(saved.bounds, isMaximized);

  if (!isMaximized) {
    mainWindow.setBounds(bounds, false);
  }

  keepDockHidden();
  mainWindow.setOpacity(1);
  mainWindow.setSkipTaskbar(process.platform === "darwin");
  // 调用层需要压在全屏应用之上，否则 Alt+E 在全屏 Cursor/浏览器里会“没反应”。
  try {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {}
  try {
    mainWindow.setAlwaysOnTop(true, "floating");
  } catch {
    try {
      mainWindow.setAlwaysOnTop(true);
    } catch {}
  }

  try {
    await rememberPromise;
  } catch (error) {
    console.error("rememberPasteTargetApp before show failed", error);
  }

  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (isMaximized) {
    mainWindow.maximize();
  }
  isHiddenOffscreen = false;
  if (blurHideTimer) {
    clearTimeout(blurHideTimer);
    blurHideTimer = null;
  }
  // app.hide() 之后仅 show 有时抢不到前台；steal focus + moveTop 提高唤起成功率。
  if (process.platform === "darwin") {
    try {
      app.focus({ steal: true });
    } catch {}
  }
  try {
    mainWindow.moveTop();
  } catch {}
  mainWindow.focus();
  mainWindow.webContents.send("focus-search");
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isHiddenOffscreen) {
    // 已在后台待命时，避免重复 offscreen 移动和多余 hide。
    keepDockHidden();
    return;
  }

  // 仅在真实显示过时保存几何，防止 offscreen 污染窗口状态。
  if (mainWindow.isVisible()) {
    saveWindowState();
  }

  const bounds = mainWindow.getBounds();
  const displays = screen.getAllDisplays();
  const rightMost = Math.max(
    ...displays.map((d) => d.bounds.x + d.bounds.width),
  );
  const offscreenX = rightMost + bounds.width + 1000;
  const offscreenY = bounds.y;

  isHiddenOffscreen = true;

  // 先解除置顶，避免隐藏后仍抢焦点 / 压在前台。
  try {
    mainWindow.setAlwaysOnTop(false);
  } catch {}
  try {
    mainWindow.setVisibleOnAllWorkspaces(false);
  } catch {}

  // 先隐藏窗口，让焦点回到之前的应用
  try {
    mainWindow.blur();
  } catch {}

  // macOS 上使用 app.hide() 可以更好地恢复焦点
  if (process.platform === "darwin") {
    try {
      app.hide();
    } catch {}
  }

  keepDockHidden();
  mainWindow.setOpacity(0);
  mainWindow.setSkipTaskbar(true);
  mainWindow.setBounds(
    {
      x: offscreenX,
      y: offscreenY,
      width: bounds.width,
      height: bounds.height,
    },
    false,
  );
}

function requestHideMainWindow({ force = false } = {}) {
  // 管理弹层锁定时：全局快捷键/托盘隐藏/点关闭不应直接藏窗清草稿。
  // 粘贴主路径等仍走 hideMainWindow() 强制隐藏。
  if (
    !force &&
    blurHideLocked &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !isHiddenOffscreen
  ) {
    try {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      }
      mainWindow.webContents.send("manage-layer-blocks-hide");
    } catch (error) {
      console.error("notify manage-layer-blocks-hide failed", error);
    }
    return false;
  }
  hideMainWindow();
  return true;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runOsascript(lines, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const args = lines.flatMap((line) => ["-e", line]);
    // 调用层不能被卡死的 osascript 拖住：默认 1s 超时，失败走回退路径。
    execFile(
      "osascript",
      args,
      { timeout: Math.max(200, Number(timeoutMs) || 1000), maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function getAccessibilityTargetInfo() {
  return {
    targetName: app.isPackaged ? app.getName() : "Electron",
    targetPath: process.execPath,
    isPackaged: app.isPackaged,
  };
}

function classifyAppleScriptPasteError(error) {
  const message = String(error instanceof Error ? error.message : error || "");

  if (
    message.includes("(-1743)") ||
    /not authorized to send apple events to system events/i.test(message)
  ) {
    return {
      type: "automation",
      message,
    };
  }

  if (
    message.includes("(-1719)") ||
    /assistive access/i.test(message) ||
    /not allowed assistive access/i.test(message) ||
    /not allowed to send keystrokes/i.test(message)
  ) {
    return {
      type: "accessibility",
      message,
    };
  }

  return {
    type: "unknown",
    message,
  };
}

async function openPrivacySettingsPane(pane) {
  if (process.platform !== "darwin") {
    return false;
  }

  const url = `x-apple.systempreferences:com.apple.preference.security?${pane}`;

  try {
    suppressBlurHide(12000);
    await shell.openExternal(url);
    return true;
  } catch (error) {
    console.error(`Open privacy pane failed: ${pane}`, error);
    return false;
  }
}

function resolvePasteTargetApp() {
  const current = String(lastPasteTargetApp || "").trim();
  if (current && !isSelfAppName(current)) return current;
  const fallback = String(prefsStore.get("lastSuccessfulPasteTarget") || "").trim();
  if (fallback && !isSelfAppName(fallback)) return fallback;
  return "";
}

function rememberSuccessfulPasteTarget(name, pid = 0) {
  const target = String(name || "").trim();
  if (!target || isSelfAppName(target)) return;
  lastPasteTargetApp = target;
  const nextPid = Number(pid) || 0;
  if (nextPid > 0) {
    lastPasteTargetPid = nextPid;
  }
  try {
    prefsStore.set("lastSuccessfulPasteTarget", target);
  } catch (error) {
    console.error("persist lastSuccessfulPasteTarget failed", error);
  }
}

// 成功粘贴后尽量恢复用户原剪贴板，避免调用层长期占用剪贴板。
// 仅当剪贴板仍是本次提示词时才恢复，避免覆盖用户随后的复制。
function clearClipboardRestoreTimer() {
  if (clipboardRestoreTimer) {
    clearTimeout(clipboardRestoreTimer);
    clipboardRestoreTimer = null;
  }
}

function flushClipboardRestoreIfNeeded() {
  // 退出/再次粘贴前：若剪贴板仍是本次提示词，立刻还回用户原文。
  const pending = clipboardRestorePending;
  clipboardRestorePending = null;
  clearClipboardRestoreTimer();
  if (!pending) return false;
  const expected = String(pending.expected ?? "");
  const previous = String(pending.previous ?? "");
  if (!expected || expected === previous) return false;
  try {
    if (clipboard.readText() === expected) {
      clipboard.writeText(previous);
      return true;
    }
  } catch (error) {
    console.error("clipboard restore flush failed", error);
  }
  return false;
}

function scheduleClipboardRestore(previousText, pastedText) {
  const expected = String(pastedText ?? "");
  const previous = String(previousText ?? "");
  if (!expected || expected === previous) return;
  // 再次粘贴时取消上一次恢复，避免连续调用把剪贴板抢回旧内容。
  clearClipboardRestoreTimer();
  clipboardRestorePending = { expected, previous };
  // 给同内容多处 Cmd+V 留窗口；仍仅在剪贴板还是本次提示词时恢复。
  clipboardRestoreTimer = setTimeout(() => {
    clipboardRestoreTimer = null;
    const pending = clipboardRestorePending;
    clipboardRestorePending = null;
    if (!pending) return;
    try {
      if (clipboard.readText() === pending.expected) {
        clipboard.writeText(pending.previous);
      }
    } catch (error) {
      console.error("clipboard restore failed", error);
    }
  }, 2800);
}

function processNamesMatch(left, right) {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  if (!a || !b) return false;
  return a === b;
}

async function waitForNaturalExternalFrontmost(maxMs = 220, stepMs = 35) {
  // hide/app.hide 后轮询自然前台：比固定 sleep 更贴合真实让出时机，
  // 既缩短平均等待，也减少“还没让出就 Cmd+V”的失败。
  const budget = Math.max(40, Number(maxMs) || 220);
  const step = Math.max(20, Number(stepMs) || 35);
  const started = Date.now();
  let last = { name: "", pid: 0 };
  while (Date.now() - started < budget) {
    try {
      last = await getFrontmostAppInfoFast();
    } catch {
      last = { name: "", pid: 0 };
    }
    if (last.name && !isSelfAppName(last.name)) return last;
    await delay(step);
  }
  try {
    last = await getFrontmostAppInfo();
  } catch {
    last = { name: "", pid: 0 };
  }
  if (last.name && !isSelfAppName(last.name)) return last;
  return { name: "", pid: 0 };
}

async function activatePasteTargetApp() {
  const target = resolvePasteTargetApp();
  const pid = Number(lastPasteTargetPid) || 0;

  // 路径 0：按唤起时记录的 pid 激活。
  // 只拒绝“进程已死 / 变成自己”：LSDisplayName 与 ps comm 常不一致（微信/WeChat），
  // 不能因字符串不等就丢掉仍有效的 pid（pid 在一次粘贴窗口内复用概率极低）。
  if (pid > 0) {
    try {
      const liveName = await getProcessNameByPid(pid);
      if (!liveName || isSelfAppName(liveName)) {
        lastPasteTargetPid = 0;
      } else {
        const expected = String(lastPasteTargetApp || target || "").trim();
        if (expected && !processNamesMatch(liveName, expected)) {
          // 纠正为 System Events 可识别的进程名，供路径 1 回退。
          lastPasteTargetApp = liveName;
        }
        await runOsascript([
          'tell application "System Events"',
          `set frontmost of first process whose unix id is ${pid} to true`,
          "end tell",
        ]);
        await delay(80);
        return true;
      }
    } catch (error) {
      console.error("activate via pid failed", pid, error);
      lastPasteTargetPid = 0;
    }
  }

  if (!target) {
    await delay(160);
    return false;
  }
  const safe = escapeAppleScriptString(target);
  // 路径 1：System Events 进程名（与 getFrontmostAppName 一致）
  try {
    await runOsascript([
      'tell application "System Events"',
      `if not (exists process "${safe}") then error "process missing"`,
      `set frontmost of first process whose name is "${safe}" to true`,
      "end tell",
    ]);
    await delay(100);
    return true;
  } catch (error) {
    console.error("activate via process failed", target, error);
  }
  // 路径 2：tell application activate（部分 App 进程名与应用名不一致时更稳）
  try {
    await runOsascript([`tell application "${safe}" to activate`]);
    await delay(120);
    return true;
  } catch (error) {
    console.error("activate via application failed", target, error);
    await delay(140);
    return false;
  }
}

async function sendPasteKeystroke() {
  await runOsascript([
    'tell application "System Events"',
    'keystroke "v" using command down',
    "end tell",
  ]);
}

async function pasteClipboardToFrontmostApp() {
  if (process.platform !== "darwin") {
    return { pasted: false, frontmost: "", pid: 0 };
  }

  // 优先信任 hide/app.hide 后的自然前台。只有焦点还停在自己身上时，
  // 才强制激活记忆目标，避免“上次成功应用”把粘贴抢到错误窗口。
  async function resolveExternalFrontmost() {
    let info = await waitForNaturalExternalFrontmost(220, 35);
    if (info.name && !isSelfAppName(info.name)) {
      return info;
    }
    await activatePasteTargetApp();
    info = await waitForNaturalExternalFrontmost(160, 40);
    if (info.name && !isSelfAppName(info.name)) return info;
    await activatePasteTargetApp();
    await delay(80);
    info = await getFrontmostAppInfo();
    if (!info.name || isSelfAppName(info.name)) return { name: "", pid: 0 };
    return info;
  }

  let frontInfo = await resolveExternalFrontmost();
  if (!frontInfo.name) {
    return { pasted: false, frontmost: "", pid: 0 };
  }

  async function keystrokeAndConfirm(info) {
    await sendPasteKeystroke();
    // 键击成功后复核：只有仍停在自己身上才判定失败。
    // 读不到前台名时信任键击前已确认的外部应用，避免 lsappinfo 抖动误报未粘贴。
    await delay(40);
    let after = { name: "", pid: 0 };
    try {
      after = await getFrontmostAppInfoFast();
    } catch {
      after = { name: "", pid: 0 };
    }
    if (!after.name) {
      try {
        after = await getFrontmostAppInfo();
      } catch {
        after = { name: "", pid: 0 };
      }
    }
    if (after.name && isSelfAppName(after.name)) {
      return { pasted: false, frontmost: after.name, pid: Number(after.pid) || 0 };
    }
    return {
      pasted: true,
      frontmost: after.name || info.name || "",
      pid: Number(after.pid) || Number(info.pid) || 0,
    };
  }

  try {
    return await keystrokeAndConfirm(frontInfo);
  } catch (firstError) {
    // 目标应用刚失焦或 System Events 瞬时拒绝时，重确认前台后再试一次。
    console.error("paste keystroke failed, retrying once", firstError);
    await delay(140);
    frontInfo = await resolveExternalFrontmost();
    if (!frontInfo.name) {
      return { pasted: false, frontmost: "", pid: 0 };
    }
    return await keystrokeAndConfirm(frontInfo);
  }
}

function ensureAccessibilityPermission() {
  if (process.platform !== "darwin") {
    return true;
  }
  if (systemPreferences.isTrustedAccessibilityClient(false)) {
    return true;
  }

  // 调用主路径优先：不在这里弹阻塞对话框（渲染进程会发通知并引导设置）。
  // 每个会话最多触发一次系统授权提示，避免连点粘贴时反复打断。
  if (!accessibilityPromptTriggered) {
    accessibilityPromptTriggered = true;
    try {
      systemPreferences.isTrustedAccessibilityClient(true);
    } catch (error) {
      console.error("trigger accessibility prompt failed", error);
    }
  }
  return false;
}

function toggleMainWindow() {
  if (!mainWindow) return;
  if (!mainWindow.isVisible() || isHiddenOffscreen) {
    void showMainWindow();
  } else {
    requestHideMainWindow();
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const openAtLogin = getOpenAtLogin();
  const menu = Menu.buildFromTemplate([
    { label: "显示窗口", click: () => void showMainWindow() },
    { label: "隐藏窗口", click: () => requestHideMainWindow() },
    { type: "separator" },
    {
      label: "登录时启动",
      type: "checkbox",
      checked: openAtLogin,
      click: (item) => {
        try {
          const next = setOpenAtLogin(item.checked);
          item.checked = next;
        } catch (error) {
          item.checked = getOpenAtLogin();
          dialog.showErrorBox("设置失败", String(error?.message || error));
        }
      },
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function setupTray() {
  const iconPath = getExtraResourcePath("assets", "trayTemplate.png");
  if (!app.isPackaged) {
    console.log("托盘图标路径:", iconPath);
  }
  tray = new Tray(iconPath);
  tray.setToolTip(`PromptBox · ${activeGlobalHotkey || "Alt+E"}`);
  rebuildTrayMenu();
  // 点托盘会先让窗口失焦；先抑制，避免刚点菜单/切换时被 hide-on-blur 抢走。
  tray.on("click", () => {
    suppressBlurHide(800);
    toggleMainWindow();
  });
  tray.on("right-click", () => {
    suppressBlurHide(4000);
  });
}

const GLOBAL_HOTKEY_CANDIDATES = [
  "Alt+E",
  "Alt+Space",
  "Option+Command+P",
  "Command+Shift+.",
];

function getPreferredGlobalHotkey() {
  return String(prefsStore.get("preferredGlobalHotkey") || "Alt+E").trim() || "Alt+E";
}

function getGlobalHotkeyCandidates(preferred = getPreferredGlobalHotkey()) {
  // 偏好键优先，其余为冲突回退/手动切换候选。
  return [preferred, ...GLOBAL_HOTKEY_CANDIDATES].filter(
    (item, index, arr) => item && arr.indexOf(item) === index,
  );
}

function getHotkeyInfo() {
  const preferred = getPreferredGlobalHotkey();
  const active = activeGlobalHotkey || preferred;
  return {
    preferred,
    active,
    candidates: getGlobalHotkeyCandidates(preferred),
    isFallback: Boolean(active) && active !== preferred,
  };
}

function refreshHotkeyUiSurfaces() {
  if (tray && !tray.isDestroyed?.()) {
    try {
      tray.setToolTip(`PromptBox · ${activeGlobalHotkey || "Alt+E"}`);
    } catch {}
  }
}

function setupGlobalShortcut({ notifyFallback = true } = {}) {
  const preferred = getPreferredGlobalHotkey();
  // 冲突时本会话回退；不自动改写用户偏好，避免“被静默改键”。
  const candidates = getGlobalHotkeyCandidates(preferred);

  const onToggle = () => {
    if (!app.isPackaged) {
      console.log("global hotkey triggered", activeGlobalHotkey);
    }
    toggleMainWindow();
  };

  try {
    globalShortcut.unregisterAll();
  } catch {}

  let registered = "";
  for (const accelerator of candidates) {
    try {
      const ok = globalShortcut.register(accelerator, onToggle);
      if (ok) {
        registered = accelerator;
        break;
      }
    } catch (error) {
      console.error("register hotkey failed", accelerator, error);
    }
  }

  activeGlobalHotkey = registered || preferred;
  refreshHotkeyUiSurfaces();

  if (!app.isPackaged) {
    console.log("快捷键注册结果:", Boolean(registered), activeGlobalHotkey);
    console.log("是否为打包版本:", app.isPackaged);
    console.log("macOS 平台:", process.platform === "darwin");
  }

  if (!registered) {
    const { targetName, targetPath, isPackaged } = getAccessibilityTargetInfo();
    const msg =
      process.platform === "darwin"
        ? isPackaged
          ? `快捷键注册失败！\n\nmacOS 系统需要授予辅助功能权限才能使用全局快捷键。\n\n请打开：系统设置 -> 隐私与安全性 -> 辅助功能 -> 启用“${targetName}”`
          : `快捷键注册失败！\n\n当前是开发模式，请在“系统设置 -> 隐私与安全性 -> 辅助功能”里启用“${targetName}”，而不是“${app.getName()}”。\n\n可执行文件路径：${targetPath}`
        : "全局快捷键均被占用，请关闭冲突应用后重启 PromptBox。";
    dialog.showErrorBox("快捷键注册失败", msg);
    return getHotkeyInfo();
  }

  if (notifyFallback && registered !== preferred) {
    try {
      new Notification({
        title: "PromptBox 快捷键已回退",
        body: `${preferred} 不可用，本会话改用 ${registered}。可在系统菜单固定或切换。`,
      }).show();
    } catch (error) {
      console.error("hotkey fallback notify failed", error);
    }
  }
  return getHotkeyInfo();
}

function setPreferredGlobalHotkey(accelerator) {
  const next = String(accelerator || "").trim();
  if (!next) {
    throw new Error("hotkey required");
  }
  // 允许偏好为内置候选，或当前已激活键（固定回退键）。
  const allowed = new Set([
    ...GLOBAL_HOTKEY_CANDIDATES,
    getPreferredGlobalHotkey(),
    activeGlobalHotkey,
  ].filter(Boolean));
  if (!allowed.has(next)) {
    throw new Error("unsupported hotkey");
  }
  prefsStore.set("preferredGlobalHotkey", next);
  return setupGlobalShortcut({ notifyFallback: true });
}

function cyclePreferredGlobalHotkey() {
  const preferred = getPreferredGlobalHotkey();
  const list = getGlobalHotkeyCandidates(preferred);
  const idx = Math.max(0, list.indexOf(preferred));
  const next = list[(idx + 1) % list.length] || "Alt+E";
  prefsStore.set("preferredGlobalHotkey", next);
  return setupGlobalShortcut({ notifyFallback: true });
}

function pinActiveGlobalHotkey() {
  const active = String(activeGlobalHotkey || "").trim();
  if (!active) {
    throw new Error("no active hotkey");
  }
  prefsStore.set("preferredGlobalHotkey", active);
  return setupGlobalShortcut({ notifyFallback: false });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    // 再次启动时唤起已有实例，而不是开第二个后台进程。
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    }
    void showMainWindow();
  });
}

app.whenReady().then(() => {
  keepDockHidden();
  createMainWindow();
  setupGlobalShortcut();
  try {
    setupTray();
  } catch (error) {
    console.error("托盘初始化失败", error);
  }
  scheduleAutoBackup();

  try {
    screen.on("display-removed", () => {
      ensureMainWindowOnVisibleDisplay();
    });
    screen.on("display-metrics-changed", () => {
      ensureMainWindowOnVisibleDisplay();
    });
  } catch (error) {
    console.error("screen display listeners failed", error);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      void showMainWindow();
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  flushClipboardRestoreIfNeeded();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  // 托盘「退出」走 app.quit：先让渲染进程刷完 saveChain，再真正退出。
  if (allowQuit || quitFlushInProgress) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    flushClipboardRestoreIfNeeded();
    return;
  }
  event.preventDefault();
  quitFlushInProgress = true;
  let finished = false;
  const finishQuit = () => {
    if (finished) return;
    finished = true;
    quitFlushInProgress = false;
    allowQuit = true;
    flushClipboardRestoreIfNeeded();
    app.quit();
  };
  const onDone = () => {
    clearTimeout(timer);
    finishQuit();
  };
  const timer = setTimeout(() => {
    // 超时仍退出，避免渲染进程卡死拖住托盘退出。
    ipcMain.removeListener("prepare-quit-done", onDone);
    finishQuit();
  }, 1200);
  ipcMain.once("prepare-quit-done", onDone);
  try {
    mainWindow.webContents.send("prepare-quit");
  } catch (error) {
    console.error("prepare-quit send failed", error);
    ipcMain.removeListener("prepare-quit-done", onDone);
    clearTimeout(timer);
    finishQuit();
  }
});

function getWebdavConfig() {
  const config = webdavStore.store || {};
  return {
    url: config.url || "",
    username: config.username || "",
    password: config.password || "",
    directory: config.directory || "prompt-box-backups",
  };
}

function getWebdavSettings() {
  const config = webdavStore.store || {};
  return {
    autoBackupEnabled: config.autoBackupEnabled !== false,
    intervalDays: Number(config.intervalDays || 3),
    lastAutoBackupAt: Number(config.lastAutoBackupAt || 0),
  };
}

function ensureWebdavConfig() {
  const config = getWebdavConfig();
  if (config.url && config.url.includes("jianguoyun-dav-proxy")) {
    config.url = "https://dav.jianguoyun.com/dav/";
  }
  if (!config.url || !config.username || !config.password) {
    throw new Error("请先配置 WebDAV");
  }
  if (config.url.startsWith("/")) {
    throw new Error("WebDAV 地址需要完整 URL（如 https://dav.jianguoyun.com/dav/）");
  }
  return config;
}

function createWebdavClient() {
  const config = ensureWebdavConfig();
  return createClient(config.url, {
    username: config.username,
    password: config.password,
  });
}

function buildBackupFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `prompt-box-backup-${stamp}.json`;
}

function normalizeDir(dir) {
  const safe = (dir || "prompt-box-backups").trim().replace(/\\+/g, "/");
  if (!safe) return "/prompt-box-backups";
  return safe.startsWith("/") ? safe : `/${safe}`;
}

let autoBackupTimer = null;

function scheduleAutoBackup() {
  if (autoBackupTimer) clearInterval(autoBackupTimer);
  autoBackupTimer = setInterval(async () => {
    try {
      const settings = getWebdavSettings();
      if (!settings.autoBackupEnabled) return;
      const intervalMs = settings.intervalDays * 24 * 60 * 60 * 1000;
      const last = settings.lastAutoBackupAt || 0;
      if (Date.now() - last < intervalMs) return;
      const result = await backupWebdavInternal();
      webdavStore.set({ lastAutoBackupAt: Date.now() });
      if (mainWindow) {
        mainWindow.webContents.send("auto-backup", result?.fileName || "");
      }
    } catch (err) {
      console.error("Auto backup failed", err);
    }
  }, 60 * 60 * 1000);
}

async function backupWebdavInternal() {
  const config = ensureWebdavConfig();
  const client = createWebdavClient();
  const dir = normalizeDir(config.directory);
  const fileName = buildBackupFilename();
  const remotePath = `${dir}/${fileName}`;

  try {
    await client.createDirectory(dir);
  } catch (error) {
    // ignore if exists
  }

  const prompts = sanitizePromptList(dataStore.get("prompts") || []);
  const payload = {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    prompts,
  };
  const content = JSON.stringify(payload, null, 2);
  await client.putFileContents(remotePath, content, { overwrite: true });
  return { remotePath, fileName };
}

ipcMain.handle("minimize-window", () => {
  if (!mainWindow) return false;
  hideMainWindow();
  return true;
});

ipcMain.handle("suppress-blur-hide", (_event, ms) => {
  suppressBlurHide(Number(ms) || 3000);
  return true;
});

ipcMain.handle("set-blur-hide-locked", (_event, locked) => {
  return setBlurHideLocked(locked === true);
});

ipcMain.handle("list-safety-snapshots", () => {
  return getSafetySnapshots().map((snap, index) => ({
    index,
    at: snap?.at || "",
    count: Number(snap?.count || 0),
  }));
});

ipcMain.handle("restore-latest-safety-snapshot", async () => {
  suppressBlurHide(12000);
  const snaps = getSafetySnapshots();
  if (!snaps.length) {
    return { canceled: true, reason: "empty" };
  }
  const latest = snaps[0];
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const when = latest?.at ? String(latest.at).replace("T", " ").replace(/\.\d+Z$/, " UTC") : "未知时间";
  const result = await dialog.showMessageBox(parent, {
    type: "question",
    buttons: ["恢复这份快照", "取消"],
    defaultId: 0,
    cancelId: 1,
    title: "恢复安全快照",
    message: "用本地安全快照覆盖当前提示词？",
    detail:
      `快照时间：${when}\n` +
      `快照条数：${Number(latest?.count || 0)}\n\n` +
      "恢复前会把当前数据再存一份快照，仍可继续回退。",
  });
  if (result.response !== 0) {
    return { canceled: true };
  }
  const current = dataStore.get("prompts");
  if (Array.isArray(current) && current.length) {
    pushSafetySnapshot(current, { force: true });
  }
  const restored = sanitizePromptList(latest.prompts);
  dataStore.set("prompts", restored);
  return { canceled: false, promptsCount: restored.length, at: latest.at || "" };
});

ipcMain.handle("write-clipboard", (_event, text) => {
  if (typeof text !== "string") {
    throw new Error("text required");
  }
  // 用户主动写入（仅复制/分享）：取消待恢复，绝不把刚复制的内容在 2.8s 后抢回。
  // 注意：只取消，不 flush 回写——当前写入就是用户想要的剪贴板状态。
  clearClipboardRestoreTimer();
  clipboardRestorePending = null;
  clipboard.writeText(text);
  return true;
});

ipcMain.handle("copy-paste-prompt", async (_event, text) => {
  if (typeof text !== "string" || !text.length) {
    throw new Error("text required");
  }
  // 新一次调用：若上一次恢复还在倒计时，先按规则收尾，再占剪贴板。
  flushClipboardRestoreIfNeeded();
  // 先记下用户原剪贴板；失败回退路径会保留本次提示词方便手动粘贴。
  let previousClipboard = "";
  try {
    previousClipboard = clipboard.readText();
  } catch {}
  clipboard.writeText(text);

  if (!ensureAccessibilityPermission()) {
    hideMainWindow();
    return {
      copied: true,
      pasted: false,
      requiresAccessibilityPermission: true,
    };
  }

  hideMainWindow();
  // 极短让出：真正的前台确认在 pasteClipboard 内自适应轮询，比固定 90ms 更稳更快。
  await delay(30);

  try {
    const pasteResult = await pasteClipboardToFrontmostApp();
    const pasted = pasteResult?.pasted === true;
    if (pasted) {
      const successPid = Number(pasteResult.pid) || Number(lastPasteTargetPid) || 0;
      let successName = String(pasteResult.frontmost || resolvePasteTargetApp() || "").trim();
      // 成功后尽量把会话/持久目标收敛到 System Events 进程名，减少下次仅名称激活失败。
      if (successPid > 0) {
        try {
          const processName = await getProcessNameByPid(successPid);
          if (processName && !isSelfAppName(processName)) {
            successName = processName;
          }
        } catch {}
      }
      rememberSuccessfulPasteTarget(successName, successPid);
      scheduleClipboardRestore(previousClipboard, text);
    }
    return { copied: true, pasted };
  } catch (error) {
    const classified = classifyAppleScriptPasteError(error);
    console.error("Paste after hide failed", classified.type, classified.message);
    return {
      copied: true,
      pasted: false,
      requiresAccessibilityPermission: classified.type === "accessibility",
      requiresAutomationPermission: classified.type === "automation",
      automationTarget: classified.type === "automation" ? "System Events" : undefined,
      error: classified.message,
    };
  }
});

ipcMain.handle("open-accessibility-settings", async () => {
  return openPrivacySettingsPane("Privacy_Accessibility");
});

ipcMain.handle("open-automation-settings", async () => {
  return openPrivacySettingsPane("Privacy_Automation");
});

ipcMain.handle("get-open-at-login", () => {
  return { openAtLogin: getOpenAtLogin() };
});

ipcMain.handle("set-open-at-login", (_event, enabled) => {
  const openAtLogin = setOpenAtLogin(enabled === true);
  rebuildTrayMenu();
  return { openAtLogin };
});

ipcMain.handle("get-hotkey-info", () => {
  return getHotkeyInfo();
});

ipcMain.handle("cycle-global-hotkey", () => {
  return cyclePreferredGlobalHotkey();
});

ipcMain.handle("pin-active-global-hotkey", () => {
  return pinActiveGlobalHotkey();
});

ipcMain.handle("set-preferred-global-hotkey", (_event, accelerator) => {
  return setPreferredGlobalHotkey(accelerator);
});

ipcMain.handle("get-app-info", () => {
  return {
    name: app.getName(),
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    globalHotkey: activeGlobalHotkey || "Alt+E",
  };
});

ipcMain.handle("get-permission-diagnostics", () => {
  const accessibilityTrusted =
    process.platform === "darwin"
      ? systemPreferences.isTrustedAccessibilityClient(false)
      : true;
  return {
    platform: process.platform,
    accessibilityTrusted,
    ...getAccessibilityTargetInfo(),
  };
});

ipcMain.handle("choose-export-format", async () => {
  suppressBlurHide(12000);
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = await dialog.showMessageBox(parent, {
    type: "question",
    buttons: ["JSON", "Markdown", "CSV", "取消"],
    defaultId: 0,
    cancelId: 3,
    title: "导出提示词",
    message: "选择导出格式",
    detail: "JSON 适合完整备份；Markdown / CSV 方便分享与表格处理。",
  });
  return ["json", "markdown", "csv", "cancel"][result.response] || "cancel";
});

ipcMain.handle("export-prompts", async (_event, payload) => {
  suppressBlurHide(12000);
  let content = "";
  let defaultPath = "prompts_backup.json";
  let filters = [{ name: "JSON", extensions: ["json"] }];

  if (typeof payload === "string") {
    content = payload;
  } else if (payload && typeof payload === "object") {
    content = String(payload.content ?? "");
    if (payload.defaultPath) defaultPath = String(payload.defaultPath);
    if (Array.isArray(payload.filters) && payload.filters.length) {
      filters = payload.filters;
    }
  } else {
    throw new Error("export payload required");
  }

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "导出提示词",
    defaultPath,
    filters,
  });

  if (canceled || !filePath) {
    return { canceled: true };
  }

  await fs.promises.writeFile(filePath, content, "utf-8");
  return { canceled: false, filePath };
});

ipcMain.handle("import-prompts", async () => {
  suppressBlurHide(12000);
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "导入提示词",
    properties: ["openFile"],
    filters: [
      { name: "Prompt 文件", extensions: ["json", "md", "markdown", "csv"] },
      { name: "JSON", extensions: ["json"] },
      { name: "Markdown", extensions: ["md", "markdown"] },
      { name: "CSV", extensions: ["csv"] },
    ],
  });

  if (canceled || !filePaths?.length) {
    return { canceled: true };
  }

  const filePath = filePaths[0];
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();
  let format = "json";
  if (ext === ".md" || ext === ".markdown") format = "markdown";
  else if (ext === ".csv") format = "csv";
  return {
    canceled: false,
    raw,
    filePath,
    format,
  };
});

ipcMain.handle("choose-import-mode", async (_event, payload = {}) => {
  suppressBlurHide(12000);
  const importCount = Math.max(0, Number(payload.importCount || 0));
  const existingCount = Math.max(0, Number(payload.existingCount || 0));
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = await dialog.showMessageBox(parent, {
    type: "question",
    buttons: ["合并导入", "替换全部", "取消"],
    defaultId: 0,
    cancelId: 2,
    title: "导入提示词",
    message: `检测到 ${importCount} 条提示词`,
    detail:
      `当前已有 ${existingCount} 条。\n` +
      "合并：保留现有，并追加新项（名称+内容相同会跳过）。\n" +
      "替换：用导入内容覆盖全部现有提示词。",
  });
  return ["merge", "replace", "cancel"][result.response] || "cancel";
});

ipcMain.handle("show-notification", (_event, payload = {}) => {
  try {
    if (!Notification.isSupported()) return false;
    const title = String(payload.title || "PromptBox").trim() || "PromptBox";
    const body = String(payload.body || "").trim();
    if (!body) return false;
    const silent = payload.silent === true;
    const notification = new Notification({
      title,
      body,
      silent,
    });
    // 点通知可重新唤起，方便权限失败/未粘贴时继续处理。
    notification.on("click", () => {
      try {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createMainWindow();
        }
        void showMainWindow();
      } catch (error) {
        console.error("notification click show failed", error);
      }
    });
    notification.show();
    return true;
  } catch (error) {
    console.error("show-notification failed", error);
    return false;
  }
});

ipcMain.handle("get-prompts", () => {
  // 首次启动写入示例数据；空数组视为用户已清空，不再回种。
  if (!dataStore.has("prompts")) {
    const seeded = sanitizePromptList(getDefaultSamplePrompts());
    dataStore.set("prompts", seeded);
    return seeded;
  }
  const prompts = dataStore.get("prompts");
  if (!Array.isArray(prompts)) {
    const seeded = sanitizePromptList(getDefaultSamplePrompts());
    dataStore.set("prompts", seeded);
    return seeded;
  }
  return sanitizePromptList(prompts);
});

ipcMain.handle("get-hidden-tags", () => {
  return getHiddenTagsFromStore();
});

ipcMain.handle("set-hidden-tags", (_event, tags) => {
  return setHiddenTagsInStore(tags);
});

ipcMain.handle("set-prompts", (_event, prompts) => {
  if (!Array.isArray(prompts)) {
    throw new Error("prompts must be an array");
  }
  const existing = dataStore.get("prompts");
  const sanitized = sanitizePromptList(prompts);
  if (Array.isArray(existing) && existing.length) {
    const prevSig = promptsIdentitySignature(existing);
    const nextSig = promptsIdentitySignature(sanitized);
    // 内容集合变化才快照；纯 useCount/lastUsedAt 更新不占用安全快照。
    if (prevSig !== nextSig) {
      pushSafetySnapshot(existing);
    }
  }
  dataStore.set("prompts", sanitized);
  return sanitized;
});

ipcMain.handle("webdav-get-config", () => {
  return getWebdavConfig();
});

ipcMain.handle("webdav-set-config", (_event, config) => {
  if (!config || typeof config !== "object") {
    throw new Error("invalid config");
  }
  webdavStore.set({
    url: String(config.url || "").trim(),
    username: String(config.username || "").trim(),
    password: String(config.password || "").trim(),
    directory: String(config.directory || "prompt-box-backups").trim(),
  });
  return true;
});

ipcMain.handle("webdav-get-settings", () => {
  return getWebdavSettings();
});

ipcMain.handle("webdav-set-settings", (_event, settings) => {
  if (!settings || typeof settings !== "object") {
    throw new Error("invalid settings");
  }
  const enabled = settings.autoBackupEnabled !== false;
  const intervalDays = Math.max(1, Math.min(Number(settings.intervalDays || 3), 30));
  webdavStore.set({
    autoBackupEnabled: enabled,
    intervalDays,
  });
  return true;
});

ipcMain.handle("webdav-test", async () => {
  const client = createWebdavClient();
  await client.exists("/");
  return true;
});

ipcMain.handle("webdav-backup", async () => {
  const result = await backupWebdavInternal();
  webdavStore.set({ lastAutoBackupAt: Date.now() });
  return result;
});


function applyRestoredPrompts(rawPrompts) {
  const current = dataStore.get("prompts");
  if (Array.isArray(current) && current.length) {
    // 云端恢复会覆盖本地，先强制落一份安全快照，重启后也能回退。
    pushSafetySnapshot(current, { force: true });
  }
  const prompts = sanitizePromptList(
    Array.isArray(rawPrompts) ? rawPrompts : [],
  );
  dataStore.set("prompts", prompts);
  return prompts;
}

ipcMain.handle("webdav-restore-latest", async () => {
  const config = ensureWebdavConfig();
  const client = createWebdavClient();
  const dir = normalizeDir(config.directory);

  const exists = await client.exists(dir);
  if (!exists) {
    throw new Error("未找到远程备份目录");
  }

  const contents = await client.getDirectoryContents(dir);
  const files = (contents || [])
    .filter((item) => item.type === "file" && item.basename.endsWith(".json"))
    .sort((a, b) => new Date(b.lastmod).getTime() - new Date(a.lastmod).getTime());

  if (!files.length) {
    throw new Error("未找到可用备份");
  }

  const latest = files[0];
  const remotePath = `${dir}/${latest.basename}`;
  const raw = await client.getFileContents(remotePath, { format: "text" });
  const parsed = JSON.parse(raw);
  const prompts = applyRestoredPrompts(
    Array.isArray(parsed?.prompts) ? parsed.prompts : parsed,
  );
  return { remotePath, promptsCount: prompts.length };
});

ipcMain.handle("webdav-restore-path", async (_event, remotePath) => {
  const client = createWebdavClient();
  if (!remotePath || typeof remotePath !== "string") {
    throw new Error("remotePath required");
  }
  const raw = await client.getFileContents(remotePath, { format: "text" });
  const parsed = JSON.parse(raw);
  const prompts = applyRestoredPrompts(
    Array.isArray(parsed?.prompts) ? parsed.prompts : parsed,
  );
  return { remotePath, promptsCount: prompts.length };
});

ipcMain.handle("webdav-list-backups", async () => {
  const config = ensureWebdavConfig();
  const client = createWebdavClient();
  const dir = normalizeDir(config.directory);
  const exists = await client.exists(dir);
  if (!exists) return [];
  const contents = await client.getDirectoryContents(dir);
  return (contents || [])
    .filter((item) => item.type === "file" && item.basename.endsWith(".json"))
    .map((item) => ({
      name: item.basename,
      path: `${dir}/${item.basename}`,
      lastMod: item.lastmod,
      size: item.size,
    }))
    .sort((a, b) => new Date(b.lastMod).getTime() - new Date(a.lastMod).getTime());
});
