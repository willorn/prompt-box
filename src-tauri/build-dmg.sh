#!/usr/bin/env bash
# PromptBox Tauri 正式打包：tauri build → patch Info.plist → sign → DMG
# 产出：target/release/bundle/dmg/PromptBox_<version>_aarch64.dmg
set -euo pipefail

CERT_IDENTITY="promptbox-dev"
cd "$(dirname "$0")"

# 从 Cargo.toml 提取版本号
VERSION=$(grep '^version' Cargo.toml | head -1 | sed 's/.*"\(.*\)"/\1/')
APP_NAME="PromptBox"
BUNDLE_DIR="target/release/bundle/macos"
DMG_DIR="target/release/bundle/dmg"
APP_BUNDLE="$BUNDLE_DIR/$APP_NAME.app"
DMG_NAME="${APP_NAME}_${VERSION}_aarch64.dmg"

echo "▸ tauri build (release, app only)..."
cargo tauri build --bundles app 2>&1

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "✗ app bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

echo "▸ patching Info.plist..."
PLIST="$APP_BUNDLE/Contents/Info.plist"
# LSUIElement: 后台 app，无 Dock 图标
plutil -insert LSUIElement -bool true "$PLIST" 2>/dev/null || plutil -replace LSUIElement -bool true "$PLIST"
# NSAppleEventsUsageDescription: 自动化权限弹窗描述
plutil -insert NSAppleEventsUsageDescription -string \
  "PromptBox 需要自动化权限来激活目标应用并自动粘贴内容。" "$PLIST" 2>/dev/null \
  || plutil -replace NSAppleEventsUsageDescription -string \
  "PromptBox 需要自动化权限来激活目标应用并自动粘贴内容。" "$PLIST"

echo "▸ signing with $CERT_IDENTITY..."
codesign --force --deep --sign "$CERT_IDENTITY" "$APP_BUNDLE" 2>&1

echo "▸ creating DMG..."
mkdir -p "$DMG_DIR"
DMG_PATH="$DMG_DIR/$DMG_NAME"
rm -f "$DMG_PATH"

# 创建临时 DMG 暂存目录
STAGING=$(mktemp -d)
cp -R "$APP_BUNDLE" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" \
  -ov -format UDZO "$DMG_PATH" 2>&1

rm -rf "$STAGING"

echo ""
echo "✓ 打包完成："
echo "  App: $APP_BUNDLE"
echo "  DMG: $DMG_PATH ($(du -h "$DMG_PATH" | cut -f1))"
