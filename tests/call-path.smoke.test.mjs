import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("renderer keeps critical call-path helpers", () => {
  const src = read("renderer.js");
  for (const name of [
    "loadPrompts",
    "persistPrompts",
    "copyText",
    "copyPromptForUse",
    "usePromptAtIndex",
    "useVisiblePromptByRank",
  ]) {
    assert.match(
      src,
      new RegExp(`(?:async\\s+)?function\\s+${name}\\b`),
      `missing ${name} in renderer.js`,
    );
  }
  assert.match(src, /from\s+["']\.\/lib\/prompt-helpers\.js["']/);
  assert.match(src, /async function safeConfirm\b/);
  assert.match(src, /confirmMessage = false/);
  assert.match(src, /paste: !e\.shiftKey/);
  assert.match(src, /copyOnly/);
  assert.match(src, /closeAllBlockingLayers/);
  assert.match(src, /openAccessibilitySettings/);
  assert.match(src, /a11ySettingsOpenedThisSession/);
  assert.match(src, /automationSettingsOpenedThisSession/);
  assert.match(src, /带撤销的 toast 需要人点一下/);
  assert.match(src, /先收起 toast/);
  assert.match(src, /refreshSafetyRestoreMenuLabel/);
  assert.match(src, /toggleSystemMenu/);
  assert.match(src, /isModalLayerOpen/);
  assert.match(src, /dismissSystemMenuForCallPath/);
  assert.match(src, /setSystemMenuOpen/);
  assert.match(src, /key === \"Backspace\"/);
  assert.match(src, /aria-live/);
  assert.match(src, /searchIsEmpty/);
  assert.match(src, /isComposingKey/);
  assert.match(src, /输入法组合态回车/);
  assert.match(src, /中文输入法选词回车不触发使用/);
  assert.match(src, /输入法组合态（选词 1-9）绝不抢键/);
  assert.match(src, /输入法取消组合优先/);
  assert.match(src, /e\.key !== "\["/);
  assert.match(src, /dispatchEvent\(new Event\("input"/);
  assert.match(src, /key === \"Home\"/);
  assert.match(src, /key === \"e\"/);
  assert.match(src, /key === \"Delete\"/);
  assert.match(src, /key === \"Backspace\"/);
  assert.match(src, /key\.toLowerCase\(\) === \"n\"/);
  assert.match(src, /key\.toLowerCase\(\) === \"f\"/);
  assert.match(src, /调用层成功路径保持静默/);
  assert.match(src, /queueSilentSave/);
  assert.match(src, /setUseInFlight/);
  assert.match(src, /call-use-in-flight/);
  assert.match(src, /把菜单夹进可视区/);
  assert.match(src, /返回 boolean/);
  assert.match(src, /删除未能保存，已恢复该项/);
  assert.match(src, /保存失败，请重试/);
  assert.match(src, /置顶状态未能保存/);
  assert.match(src, /与快捷键\/预览共用 togglePinAtIndex/);
  assert.match(src, /重命名未能保存/);
  assert.match(src, /失败时不改内存/);
  assert.match(src, /WebDAV 配置保存失败/);
  assert.match(src, /隐藏分类保存失败/);
  assert.match(src, /保持弹层打开，方便用户重试/);
  assert.match(src, /flushPendingSaves/);
  assert.match(src, /onPrepareQuit/);
  assert.match(src, /prepareQuitDone/);
  assert.match(src, /isSearchEffectivelyEmpty/);
  assert.match(src, /hasSearchInputChars/);
  assert.match(src, /syncSearchClearButton/);
  assert.match(src, /searchClearBtn/);
  assert.match(src, /saveChain/);
  assert.match(src, /串行落盘/);
  assert.match(src, /成功粘贴后异步串行静默保存/);
  assert.match(src, /未保存草稿时拒绝重置表单/);
  assert.match(src, /已有未保存草稿时不切换条目/);
  assert.match(src, /与 openAddPrompt 同路径/);
  assert.match(src, /搜索时始终落到相关度第一名/);
  assert.match(src, /空搜索时数字键/);
  assert.match(src, /首次使用默认收起预览/);
  assert.match(src, /loadSidebarCollapsed/);
  assert.match(src, /toggleSidebarCollapsed/);
  assert.match(src, /headerSettingsBtn/);
  assert.match(src, /headerAddBtn/);
  assert.match(src, /openAddPrompt/);
  assert.match(src, /isPromptFormDirty/);
  assert.match(src, /isDirtyPromptModalOpen/);
  assert.match(src, /preserveDirtyPrompt/);
  assert.match(src, /有未保存的编辑，请先保存或关闭/);
  assert.match(src, /closePromptModal/);
  assert.match(src, /needsListRefresh/);
  assert.match(src, /selectFirstVisibleForCall/);
  assert.match(src, /每次唤起默认第一名/);
  assert.match(src, /armPointerHoverSelectAfterMove/);
  assert.match(src, /pointerHoverSelectEnabled/);
  assert.match(src, /selectCardUnderPoint/);
  assert.match(src, /armPointerHoverSelectAfterMove\(\)/);
  assert.match(src, /有意移动后立刻对准光标下卡片/);
  assert.match(src, /Esc 分层/);
  assert.match(src, /清空搜索 → 重置分类 → 隐藏窗口/);
  assert.match(src, /清空搜索回到干净列表/);
  assert.match(src, /输入框有字符时 ⌫ 回改搜索/);
  assert.match(src, /PageUp \/ PageDown/);
  assert.match(src, /focusSelectedOrFirstCard/);
  assert.match(src, /搜索 ↔ 列表/);
  assert.match(src, /搜索结果从顶部看起/);
  assert.match(src, /card-section-pinned/);
  assert.match(src, /card-title-row[\s\S]*card-rank/);
  assert.match(src, /空搜索：Delete \/ macOS ⌫ 删除选中/);
  assert.match(src, /selectFirstVisibleForCall\(\)/);
  assert.match(src, /未保存，再按 Esc 放弃/);
  assert.match(src, /syncBlurHideLock/);
  assert.match(src, /setBlurHideLocked/);
  assert.match(src, /onManageLayerBlocksHide/);
  assert.match(src, /resetCategoryFilterToAll/);
  assert.match(src, /干净调用态：不把上次分类筛选/);
  assert.match(src, /positionSystemMenu/);
  assert.match(src, /打开期间抑制失焦隐藏/);
  assert.match(src, /搜索框为空时也允许/);
  assert.match(src, /getSystemMenuAnchor/);
  assert.match(src, /优先当前选中/);
  assert.match(src, /已删除，可撤销/);
  assert.match(src, /Math\.min\(index, allPrompts\.length - 1\)/);
  assert.match(src, /点遮罩关闭编辑弹层/);
  assert.match(src, /已恢复/);
  assert.match(src, /refreshHotkeyMenu/);
  assert.match(src, /formatHotkeyLabel/);
  assert.match(src, /menuHotkey/);
  assert.match(src, /pinActiveGlobalHotkey/);
  assert.match(src, /cycleGlobalHotkey/);
  assert.match(src, /getHotkeyInfo/);
  assert.match(src, /系统菜单·全局快捷键/);
  assert.match(src, /已固定快捷键/);
});

test("call-layer dense styles exist when preview collapsed", () => {
  const html = read("index.html");
  assert.match(html, /预览收起时列表更密/);
  assert.match(html, /body\.preview-collapsed \.card-usage/);
  assert.match(html, /-webkit-line-clamp:\s*1/);
  assert.match(html, /call-use-in-flight/);
  assert.match(html, /id="menuHotkey"/);
  assert.match(html, /全局快捷键：Alt\+E/);
});

test("main process exposes copy-paste and hide IPC", () => {
  const src = read("main.js");
  for (const channel of [
    "copy-paste-prompt",
    "write-clipboard",
    "minimize-window",
    "get-prompts",
    "set-prompts",
    "show-notification",
    "suppress-blur-hide",
    "list-safety-snapshots",
    "restore-latest-safety-snapshot",
  ]) {
    assert.match(src, new RegExp(`ipcMain\\.handle\\(\\s*["']${channel}["']`));
  }
  assert.match(src, /function\s+showMainWindow\b/);
  assert.match(src, /function\s+hideMainWindow\b/);
  assert.match(src, /setAlwaysOnTop/);
  assert.match(src, /sandbox:\s*true/);
  assert.match(src, /setVisibleOnAllWorkspaces/);
  assert.match(src, /rememberPasteTargetApp/);
  assert.match(src, /activatePasteTargetApp/);
  assert.match(src, /process missing/);
  assert.match(src, /tell application/);
  assert.match(src, /resolvePasteTargetApp/);
  assert.match(src, /lastSuccessfulPasteTarget/);
  assert.match(src, /rememberSuccessfulPasteTarget/);
  assert.match(src, /accessibilityPromptTriggered/);
  assert.match(src, /调用主路径优先/);
  assert.match(src, /applyRestoredPrompts/);
  assert.match(src, /getDefaultSamplePrompts/);
  assert.match(src, /retrying once/);
  assert.match(src, /await delay\(30\)/);
  assert.match(src, /waitForNaturalExternalFrontmost/);
  assert.match(src, /keystrokeAndConfirm/);
  assert.match(src, /键击成功后复核/);
  assert.match(src, /读不到前台名时信任/);
  assert.match(src, /scheduleClipboardRestore/);
  assert.match(src, /clipboardRestoreTimer/);
  assert.match(src, /2800/);
  assert.match(src, /再次粘贴时取消上一次恢复/);
  assert.match(src, /resolveExternalFrontmost/);
  assert.match(src, /getFrontmostAppInfoFast/);
  assert.match(src, /parseLsappinfoDisplayName/);
  assert.match(src, /\["info",\s*"-only",\s*"pid,name"/);
  assert.match(src, /lsappinfo/);
  assert.match(src, /lastPasteTargetPid/);
  assert.match(src, /activate via pid failed/);
  assert.match(src, /processNamesMatch/);
  assert.match(src, /preferredGlobalHotkey/);
  assert.match(src, /activeGlobalHotkey/);
  assert.match(src, /pasteResult\?\.pasted === true/);
  assert.match(src, /notification\.on\(/);
  assert.match(src, /lastPasteTargetApp/);
  assert.match(src, /placeBoundsOnCursorDisplay/);
  assert.match(src, /scheduleHideOnBlur/);
  assert.match(src, /suppressBlurHide/);
  assert.match(src, /setBlurHideLocked/);
  assert.match(src, /sanitizePromptList/);
  assert.match(src, /right-click/);
  assert.match(src, /width:\s*860/);
  assert.match(src, /height:\s*600/);
  assert.match(src, /MIN_WINDOW_HEIGHT\s*=\s*520/);
  assert.match(src, /timeout:\s*Math\.max\(200, Number\(timeoutMs\)/);
  assert.match(src, /fastOnly:\s*true/);
  assert.match(src, /rememberPasteTargetApp\(\{\s*fastOnly:\s*true\s*\}\)/);
  assert.match(src, /记前台与窗口几何准备并行/);
  assert.match(src, /app\.focus\(\{\s*steal:\s*true\s*\}\)/);
  assert.match(src, /moveTop/);
  assert.match(src, /steal focus \+ moveTop/);
  assert.match(src, /render-process-gone/);
  assert.match(src, /setWindowOpenHandler/);
  assert.match(src, /ensureMainWindowOnVisibleDisplay/);
  assert.match(src, /display-removed/);
  assert.match(src, /display-metrics-changed/);
  assert.match(src, /did-finish-load/);
  assert.match(src, /focus-search after did-finish-load failed/);
  assert.match(src, /will-navigate/);
  assert.match(src, /不打开外链\/新窗/);
  assert.match(src, /reload after render-process-gone failed/);
  assert.match(src, /flushClipboardRestoreIfNeeded/);
  assert.match(src, /用户主动写入/);
  assert.match(src, /只取消，不 flush 回写/);
  assert.match(src, /clipboardRestorePending/);
  assert.match(src, /prepare-quit/);
  assert.match(src, /prepare-quit-done/);
  assert.match(src, /allowQuit/);
  assert.match(src, /app\.quit\(\)/);
  assert.match(src, /退出前先让渲染进程刷完/);
  assert.match(src, /GLOBAL_HOTKEY_CANDIDATES/);
  assert.match(src, /getHotkeyInfo/);
  assert.match(src, /cyclePreferredGlobalHotkey/);
  assert.match(src, /pinActiveGlobalHotkey/);
  assert.match(src, /setPreferredGlobalHotkey/);
  assert.match(src, /setupGlobalShortcut/);
  assert.match(src, /不自动改写用户偏好/);
  assert.match(src, /get-hotkey-info/);
  assert.match(src, /cycle-global-hotkey/);
  assert.match(src, /pin-active-global-hotkey/);
  assert.match(src, /set-preferred-global-hotkey/);
  assert.match(src, /PromptBox 快捷键已回退/);
  assert.match(src, /不能因字符串不等就丢掉仍有效的 pid/);
  assert.match(src, /纠正为 System Events 可识别的进程名/);
  assert.match(src, /收敛到 System Events 进程名/);
});

test("preload bridges call-path APIs", () => {
  const src = read("preload.cjs");
  for (const key of [
    "copyPastePrompt",
    "writeClipboard",
    "minimizeWindow",
    "getPrompts",
    "setPrompts",
    "showNotification",
    "suppressBlurHide",
    "listSafetySnapshots",
    "restoreLatestSafetySnapshot",
    "onFocusSearch",
    "onPrepareQuit",
    "prepareQuitDone",
    "getHotkeyInfo",
    "cycleGlobalHotkey",
    "pinActiveGlobalHotkey",
    "setPreferredGlobalHotkey",
  ]) {
    assert.match(src, new RegExp(`${key}\\s*:`));
  }
});

test("package scripts keep unit tests runnable", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "prompt-box-electron");
  assert.match(String(pkg.scripts?.test || ""), /node --test/);
});
