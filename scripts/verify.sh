#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> syntax check"
node --check main.js
node --check preload.cjs
node --check renderer.js
node --check lib/prompt-helpers.js

echo "==> unit + smoke tests"
node --test tests/prompt-helpers.test.mjs tests/call-path.smoke.test.mjs

echo "==> call-path symbol guard"
node --input-type=module <<'EOF'
import fs from "node:fs";
const renderer = fs.readFileSync("renderer.js", "utf8");
const main = fs.readFileSync("main.js", "utf8");
for (const name of ["loadPrompts", "copyPromptForUse", "usePromptAtIndex", "safeConfirm"]) {
  if (!new RegExp(`(?:async\\s+)?function\\s+${name}\\b`).test(renderer)) {
    throw new Error(`missing ${name} in renderer.js`);
  }
}
for (const needle of ["rememberPasteTargetApp", "activatePasteTargetApp", "applyRestoredPrompts", "scheduleHideOnBlur", "suppress-blur-hide", "set-blur-hide-locked", "blurHideLocked", "requestHideMainWindow", "manage-layer-blocks-hide", "sanitizePromptList", "getDefaultSamplePrompts", "resolvePasteTargetApp", "lastSuccessfulPasteTarget", "accessibilityPromptTriggered", "write-clipboard", "process missing", "await delay(30)", "waitForNaturalExternalFrontmost", "keystrokeAndConfirm", "读不到前台名时信任", "scheduleClipboardRestore", "clipboardRestoreTimer", "再次粘贴时取消上一次恢复", "2800", "resolveExternalFrontmost", "getFrontmostAppInfoFast", "parseLsappinfoDisplayName", "pid,name", "lsappinfo", "lastPasteTargetPid", "processNamesMatch", "preferredGlobalHotkey", "activeGlobalHotkey", "notification.on", "timeout: Math.max(200, Number(timeoutMs)", "fastOnly: true", "rememberPasteTargetApp({ fastOnly: true })", "记前台与窗口几何准备并行", "GLOBAL_HOTKEY_CANDIDATES", "getHotkeyInfo", "cyclePreferredGlobalHotkey", "pinActiveGlobalHotkey", "setPreferredGlobalHotkey", "get-hotkey-info", "cycle-global-hotkey", "pin-active-global-hotkey", "set-preferred-global-hotkey", "不自动改写用户偏好", "PromptBox 快捷键已回退", "不能因字符串不等就丢掉仍有效的 pid", "纠正为 System Events 可识别的进程名", "收敛到 System Events 进程名"]) {
  if (!main.includes(needle)) throw new Error(`missing ${needle} in main.js`);
}
if (!renderer.includes('key === "Backspace"')) {
  throw new Error("missing Backspace delete hotkey in renderer.js");
}
if (!renderer.includes("searchIsEmpty") || !renderer.includes("isComposingKey")) {
  throw new Error("missing type-to-search guards in renderer.js");
}
if (!renderer.includes("refreshHotkeyMenu") || !renderer.includes("menuHotkey") || !renderer.includes("pinActiveGlobalHotkey")) {
  throw new Error("missing global hotkey switch/pin menu in renderer.js");
}
const preload = fs.readFileSync("preload.cjs", "utf8");
if (!preload.includes("getHotkeyInfo") || !preload.includes("cycleGlobalHotkey") || !preload.includes("pinActiveGlobalHotkey")) {
  throw new Error("missing global hotkey bridges in preload.cjs");
}
if (!renderer.includes("带撤销的 toast 需要人点一下")) {
  throw new Error("missing undo-toast blur suppress in renderer.js");
}
const helpers = fs.readFileSync("lib/prompt-helpers.js", "utf8");
if (!helpers.includes("u3000") && !helpers.includes("\\u3000")) {
  throw new Error("missing fullwidth space tokenize in prompt-helpers.js");
}
if (!renderer.includes("refreshSafetyRestoreMenuLabel")) {
  throw new Error("missing safety menu label refresh in renderer.js");
}
if (!renderer.includes("isModalLayerOpen") || !renderer.includes("dismissSystemMenuForCallPath")) {
  throw new Error("missing modal/system menu call-path split in renderer.js");
}
if (!renderer.includes("空搜索时数字键") || !renderer.includes("首次使用默认收起预览")) {
  throw new Error("missing bare digit rank use / dense first-run preview in renderer.js");
}
if (!renderer.includes("仅复制成功：轻闪卡片即可，不弹 toast") || !renderer.includes("调用层成功路径保持静默")) {
  throw new Error("missing silent copy/paste success path in renderer.js");
}

if (!renderer.includes("loadSidebarCollapsed") || !renderer.includes("toggleSidebarCollapsed")) {
  throw new Error("missing sidebar collapse call-layer polish in renderer.js");
}
if (!renderer.includes("headerSettingsBtn") || !renderer.includes("positionSystemMenu")) {
  throw new Error("missing always-available system menu entry (sidebar-collapsed safe) in renderer.js");
}
if (!renderer.includes("headerAddBtn") || !renderer.includes("openAddPrompt") || !renderer.includes("resetCategoryFilterToAll")) {
  throw new Error("missing header add / clean-call filter reset in renderer.js");
}
if (!renderer.includes("syncBlurHideLock") || !renderer.includes("setBlurHideLocked")) {
  throw new Error("missing modal blur-hide lock in renderer.js");
}
if (!renderer.includes("onManageLayerBlocksHide") || !renderer.includes("请先保存或关闭当前编辑")) {
  throw new Error("missing manage-layer hotkey hide guard in renderer.js");
}
if (!renderer.includes("isPromptFormDirty") || !renderer.includes("closePromptModal") || !renderer.includes("needsListRefresh")) {
  throw new Error("missing dirty-form Esc guard / dirty list refresh in renderer.js");
}
if (!renderer.includes("isDirtyPromptModalOpen") || !renderer.includes("preserveDirtyPrompt") || !renderer.includes("有未保存的编辑，请先保存或关闭")) {
  throw new Error("missing dirty-form protect on focus-search in renderer.js");
}
if (!renderer.includes("selectFirstVisibleForCall") || !renderer.includes("每次唤起默认第一名")) {
  throw new Error("missing first-visible call-state selection in renderer.js");
}
if (!renderer.includes("armPointerHoverSelectAfterMove") || !renderer.includes("pointerHoverSelectEnabled") || !renderer.includes("selectCardUnderPoint")) {
  throw new Error("missing pointer hover-arm after intentional move in renderer.js");
}
if (!renderer.includes("armPointerHoverSelectAfterMove();") || !renderer.includes("selectFirstVisibleForCall();")) {
  throw new Error("missing onFocusSearch hover-arm + first-visible order in renderer.js");
}
if (!renderer.includes("Esc 分层") || !renderer.includes("清空搜索 → 重置分类 → 隐藏窗口")) {
  throw new Error("missing launcher Esc clean-stack in renderer.js");
}
if (!renderer.includes("输入框有字符时 ⌫ 回改搜索") || !renderer.includes("空搜索：Delete / macOS ⌫ 删除选中")) {
  throw new Error("missing Backspace-edit-search vs empty-search delete split in renderer.js");
}
if (!renderer.includes("PageUp / PageDown") || !renderer.includes("按页跳选")) {
  throw new Error("missing PageUp/PageDown call-list navigation in renderer.js");
}
if (!renderer.includes("focusSelectedOrFirstCard") || !renderer.includes("搜索 ↔ 列表") || !renderer.includes("搜索结果从顶部看起")) {
  throw new Error("missing Tab focus loop / search scroll-top polish in renderer.js");
}
if (!renderer.includes("queueSilentSave") || !renderer.includes("saveChain") || !renderer.includes("成功粘贴后异步串行静默保存") || !renderer.includes("串行落盘")) {
  throw new Error("missing queued silent post-paste save in renderer.js");
}
if (!renderer.includes("未保存草稿时拒绝重置表单") || !renderer.includes("已有未保存草稿时不切换条目") || !renderer.includes("与 openAddPrompt 同路径")) {
  throw new Error("missing dirty prompt form open guards in renderer.js");
}
if (!renderer.includes("isSearchEffectivelyEmpty") || !renderer.includes("hasSearchInputChars") || !renderer.includes("syncSearchClearButton") || !renderer.includes("searchClearBtn")) {
  throw new Error("missing whitespace-aware search emptiness / clear button in renderer.js");
}
if (!renderer.includes("card-section-pinned")) {
  throw new Error("missing pinned section visual marker in renderer.js");
}
if (!renderer.includes("<span class=\"card-rank\" hidden></span>") || !renderer.includes("card-title-row")) {
  // rank lives in title row for selection speed
}
if (!renderer.includes('card-title-row') || renderer.indexOf('card-rank') < 0) {
  throw new Error("missing rank badge placement for call selection in renderer.js");
}
if (!renderer.includes("清空搜索回到干净列表")) {
  throw new Error("missing clear-search reselect first in renderer.js");
}
const html = fs.readFileSync("index.html", "utf8");
if (!html.includes("预览收起时列表更密") || !html.includes("body.preview-collapsed .card-usage")) {
  throw new Error("missing dense call-list CSS when preview collapsed in index.html");
}
if (!html.includes('id="searchClearBtn"') || !html.includes("search-clear-btn")) {
  throw new Error("missing search clear button markup in index.html");
}
if (!html.includes('id="menuHotkey"')) {
  throw new Error("missing menuHotkey entry in index.html");
}
if (!renderer.includes("打开期间抑制失焦隐藏") || !renderer.includes("搜索框为空时也允许")) {
  throw new Error("missing system-menu blur suppress / empty-search Home-End polish in renderer.js");
}
if (!main.includes("sandbox: true") && !main.includes("sandbox:true")) {
  throw new Error("missing renderer sandbox: true in main.js");
}
if (!main.includes("width: 860") || !main.includes("height: 600") || !main.includes("MIN_WINDOW_HEIGHT = 520")) {
  throw new Error("missing compact default window bounds in main.js");
}

if (!main.includes("flushClipboardRestoreIfNeeded") || !main.includes("prepare-quit") || !main.includes("allowQuit") || !main.includes("clipboardRestorePending")) {
  throw new Error("missing quit flush / clipboard restore flush in main.js");
}
if (!main.includes("app.quit()") || main.includes("click: () => app.exit(0)")) {
  throw new Error("tray exit should use app.quit() for before-quit flush");
}
if (!renderer.includes("flushPendingSaves") || !renderer.includes("onPrepareQuit") || !renderer.includes("prepareQuitDone")) {
  throw new Error("missing prepare-quit flush path in renderer.js");
}
if (!fs.readFileSync("preload.cjs","utf8").includes("onPrepareQuit") || !fs.readFileSync("preload.cjs","utf8").includes("prepareQuitDone")) {
  throw new Error("missing prepare-quit bridges in preload.cjs");
}

if (!renderer.includes("中文输入法选词回车不触发使用") || !renderer.includes("输入法组合态（选词 1-9）绝不抢键") || !renderer.includes("输入法取消组合优先")) {
  throw new Error("missing IME composition guards in renderer.js");
}
if (!main.includes("用户主动写入") || !main.includes("只取消，不 flush 回写")) {
  throw new Error("missing write-clipboard cancel restore in main.js");
}

if (!renderer.includes("返回 boolean") || !renderer.includes("删除未能保存，已恢复该项") || !renderer.includes("保存失败，请重试")) {
  throw new Error("missing save failure rollback paths in renderer.js");
}
if (!main.includes("app.focus({ steal: true })") || !main.includes("moveTop") || !main.includes("steal focus + moveTop")) {
  throw new Error("missing macOS show focus steal in main.js");
}

if (!renderer.includes("与快捷键/预览共用 togglePinAtIndex") || !renderer.includes("重命名未能保存")) {
  throw new Error("missing context pin / rename rollback in renderer.js");
}
if (!main.includes("render-process-gone") || !main.includes("reload after render-process-gone failed")) {
  throw new Error("missing render-process-gone recovery in main.js");
}

if (!renderer.includes("失败时不改内存") || !renderer.includes("隐藏分类保存失败") || !renderer.includes("保持弹层打开，方便用户重试")) {
  throw new Error("missing hidden-tags persist failure handling in renderer.js");
}
if (!main.includes("setWindowOpenHandler") || !main.includes("will-navigate") || !main.includes("不打开外链/新窗")) {
  throw new Error("missing navigation lockdown in main.js");
}

if (!main.includes("ensureMainWindowOnVisibleDisplay") || !main.includes("display-removed") || !main.includes("did-finish-load")) {
  throw new Error("missing display relocate / did-finish-load focus recovery in main.js");
}
if (!renderer.includes("WebDAV 配置保存失败")) {
  throw new Error("missing webdav config save error handling in renderer.js");
}

if (!renderer.includes("setUseInFlight") || !renderer.includes("call-use-in-flight") || !renderer.includes("把菜单夹进可视区")) {
  throw new Error("missing use-in-flight lock / context menu clamp in renderer.js");
}
if (!html.includes("call-use-in-flight")) {
  throw new Error("missing call-use-in-flight styles in index.html");
}
console.log("call-path guards ok");
EOF

echo "verify passed"
