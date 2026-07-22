#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
DMG="dist/PromptBox-${VERSION}-arm64.dmg"
ASAR="dist/mac-arm64/PromptBox.app/Contents/Resources/app.asar"
SOURCES=(main.js renderer.js preload.cjs lib/prompt-helpers.js package.json index.html)

echo "==> release preflight (version ${VERSION})"

echo "==> verify"
bash ./scripts/verify.sh

echo "==> release notes"
test -f ".github/release-notes-${VERSION}.md" || {
  echo "missing .github/release-notes-${VERSION}.md" >&2
  exit 1
}

echo "==> package artifacts"
test -f "$DMG" || { echo "missing $DMG — run: bun run build" >&2; exit 1; }
test -f "$ASAR" || { echo "missing $ASAR — run: bun run build:dir" >&2; exit 1; }

echo "==> package freshness vs source"
dmg_m="$(stat -f %m "$DMG" 2>/dev/null || stat -c %Y "$DMG")"
asar_m="$(stat -f %m "$ASAR" 2>/dev/null || stat -c %Y "$ASAR")"
for f in "${SOURCES[@]}"; do
  src_m="$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")"
  if (( src_m > dmg_m )); then
    echo "stale DMG: $f is newer than $DMG — run: bun run build" >&2
    exit 1
  fi
  if (( src_m > asar_m )); then
    echo "stale app: $f is newer than $ASAR — run: bun run build:dir" >&2
    exit 1
  fi
done

echo "==> asar critical symbols"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

if ! command -v npx >/dev/null 2>&1; then
  echo "npx unavailable; cannot extract asar" >&2
  exit 1
fi
npx --yes asar extract "$ASAR" "$TMP/asar" >/dev/null

for f in main.js renderer.js preload.cjs lib/prompt-helpers.js package.json; do
  test -f "$TMP/asar/$f" || { echo "asar missing $f" >&2; exit 1; }
done

ASAR_CHECK_ROOT="$TMP/asar" node --input-type=module <<'EOF'
import fs from "node:fs";
import path from "node:path";
const root = process.env.ASAR_CHECK_ROOT;
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.cjs"), "utf8");
for (const needle of [
  "rememberPasteTargetApp",
  "resolvePasteTargetApp",
  "write-clipboard",
  "accessibilityPromptState",
  "getAccessibilityIdentity",
  "isAccessibilityTrusted",
  "noteAccessibilityTrustRevoked",
  "ACCESSIBILITY_PROMPT_COOLDOWN_MS",
  "accessibilityIdentity",
  "await delay(30)", "waitForNaturalExternalFrontmost", "keystrokeAndConfirm", "读不到前台名时信任",
  "scheduleClipboardRestore",
  "clipboardRestoreTimer",
  "再次粘贴时取消上一次恢复",
  "2800",
  "resolveExternalFrontmost",
  "getFrontmostAppInfoFast",
  "parseLsappinfoDisplayName",
  "pid,name",
  "lsappinfo",
  "lastPasteTargetPid",
  "processNamesMatch",
  "preferredGlobalHotkey",
  "GLOBAL_HOTKEY_CANDIDATES",
  "getHotkeyInfo",
  "cyclePreferredGlobalHotkey",
  "pinActiveGlobalHotkey",
  "setPreferredGlobalHotkey",
  "get-hotkey-info",
  "cycle-global-hotkey",
  "pin-active-global-hotkey",
  "不自动改写用户偏好",
  "PromptBox 快捷键已回退",
  "不能因字符串不等就丢掉仍有效的 pid",
  "纠正为 System Events 可识别的进程名",
  "收敛到 System Events 进程名",
  "flushClipboardRestoreIfNeeded",
  "用户主动写入",
  "只取消，不 flush 回写",
  "prepare-quit",
  "steal focus + moveTop",
  "moveTop",
  "render-process-gone",
  "setWindowOpenHandler",
  "ensureMainWindowOnVisibleDisplay",
  "display-removed",
  "did-finish-load",
  "will-navigate",
  "不打开外链/新窗",
  "allowQuit",
  "clipboardRestorePending",
  "activeGlobalHotkey",
  "blurHideLocked",
  "set-blur-hide-locked",
  "requestHideMainWindow",
  "manage-layer-blocks-hide",
  "fastOnly: true",
  "记前台与窗口几何准备并行",
  "timeout: Math.max(200, Number(timeoutMs)",
]) {
  if (!main.includes(needle)) throw new Error(`asar main missing ${needle}`);
}
for (const needle of [
  "copyPromptForUse",
  "usePromptAtIndex",
  "writeClipboard",
  "toggleSystemMenu",
  "refreshSafetyRestoreMenuLabel",
  "syncBlurHideLock",
  "setBlurHideLocked",
  "onManageLayerBlocksHide",
  "请先保存或关闭当前编辑",
  "isPromptFormDirty",
  "isDirtyPromptModalOpen",
  "未保存草稿时拒绝重置表单",
  "串行落盘",
  "已有未保存草稿时不切换条目",
  "preserveDirtyPrompt",
  "有未保存的编辑，请先保存或关闭",
  "closePromptModal",
  "needsListRefresh",
  "selectFirstVisibleForCall",
  "每次唤起默认第一名",
  "armPointerHoverSelectAfterMove",
  "pointerHoverSelectEnabled",
  "selectCardUnderPoint",
  "Esc 分层",
  "清空搜索回到干净列表",
  "输入框有字符时 ⌫ 回改搜索",
  "PageUp / PageDown",
  "按页跳选",
  "focusSelectedOrFirstCard",
  "搜索 ↔ 列表",
  "搜索结果从顶部看起",
  "card-section-pinned",
  "queueSilentSave",
  "setUseInFlight",
  "call-use-in-flight",
  "把菜单夹进可视区",
  "flushPendingSaves",
  "返回 boolean",
  "删除未能保存，已恢复该项",
  "保存失败，请重试",
  "置顶状态未能保存",
  "与快捷键/预览共用 togglePinAtIndex",
  "重命名未能保存",
  "失败时不改内存",
  "WebDAV 配置保存失败",
  "隐藏分类保存失败",
  "保持弹层打开，方便用户重试",
  "中文输入法选词回车不触发使用",
  "输入法组合态（选词 1-9）绝不抢键",
  "输入法取消组合优先",
  "onPrepareQuit",
  "prepareQuitDone",
  "saveChain",
  "串行落盘",
  "成功粘贴后异步串行静默保存",
  "仅复制成功：轻闪卡片即可，不弹 toast",
  "复制成功不 toast",
  "未自动粘贴：内容已在剪贴板",
  "未保存草稿时拒绝重置表单",
  "已有未保存草稿时不切换条目",
  "与 openAddPrompt 同路径",
  "isSearchEffectivelyEmpty",
  "hasSearchInputChars",
  "syncSearchClearButton",
  "searchClearBtn",
  "空搜索：Delete / macOS ⌫ 删除选中",
  "refreshHotkeyMenu",
  "formatHotkeyLabel",
  "menuHotkey",
  "pinActiveGlobalHotkey",
  "cycleGlobalHotkey",
  "getHotkeyInfo",
  "系统菜单·全局快捷键",
  "已固定快捷键",
]) {
  if (!renderer.includes(needle)) throw new Error(`asar renderer missing ${needle}`);
}
if (!preload.includes("writeClipboard") || !preload.includes("copyPastePrompt")) {
  throw new Error("asar preload missing clipboard bridges");
}
if (!preload.includes("onPrepareQuit") || !preload.includes("prepareQuitDone")) {
  throw new Error("asar preload missing prepare-quit bridges");
}
if (!preload.includes("getHotkeyInfo") || !preload.includes("cycleGlobalHotkey") || !preload.includes("pinActiveGlobalHotkey")) {
  throw new Error("asar preload missing hotkey bridges");
}
console.log("asar symbols ok");
EOF

echo "preflight passed"
echo "ready for commit/tag/release (requires explicit user approval)"
