#!/usr/bin/env bash
# PromptBox Tauri 一键重打包：build → deploy → sign → restart
# 用法: ./redeploy.sh          (默认 release)
#       ./redeploy.sh --dev    (debug 构建，编译更快)
set -euo pipefail

APP_BUNDLE="/Applications/PromptBox.app"
BINARY_NAME="prompt-box"
CERT_IDENTITY="promptbox-dev"
# 粘贴链诊断日志由 app 自身落盘（src/paste.rs::log），每次进程启动截断重写。
LOG_FILE="$HOME/Library/Application Support/com.promptmaster.desktop.tauri/paste.log"

MODE="release"
CARGO_FLAG="--release"
if [[ "${1:-}" == "--dev" ]]; then
  MODE="debug"
  CARGO_FLAG=""
fi

cd "$(dirname "$0")"

echo "▸ cargo build ($MODE)..."
cargo build $CARGO_FLAG 2>&1

BINARY="target/$MODE/$BINARY_NAME"
if [[ ! -f "$BINARY" ]]; then
  echo "✗ binary not found: $BINARY" >&2
  exit 1
fi

echo "▸ killing running instance..."
pgrep -f "$APP_BUNDLE/Contents/MacOS/$BINARY_NAME" | xargs kill 2>/dev/null || true
sleep 0.5

echo "▸ deploying to $APP_BUNDLE..."
cp "$BINARY" "$APP_BUNDLE/Contents/MacOS/$BINARY_NAME"

echo "▸ signing with $CERT_IDENTITY..."
codesign --force --sign "$CERT_IDENTITY" "$APP_BUNDLE" 2>&1

echo "▸ relaunching..."
# ⚠️ 不要用 `open --stderr`：GUI 应用经 LaunchServices 拉起时该重定向实测不生效
# （文件恒为 0 字节），日志会直接丢掉。app 自己写 LOG_FILE。
open "$APP_BUNDLE"

echo "✓ redeploy done (log: $LOG_FILE)"
