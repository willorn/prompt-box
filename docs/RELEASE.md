# 发布流程

这份文档约定 PromptBox 的标准发布流程。后续发版默认按这里执行，避免版本号、Tag、安装包和 GitHub Release 脱节。

## 当前发布约定

- 仓库：`https://github.com/willorn/prompt-box`
- 默认分支：`main`
- 版本号来源：[package.json](../package.json)
- Tag 命名：`electron-v<version>`
- 当前正式发布产物：`dist/PromptBox-<version>-arm64.dmg`

## 什么时候发版

满足以下条件后再发版：

- 本次要发布的代码已经在本地验证通过
- [package.json](../package.json) 的版本号已经更新
- 工作区是干净的，没有未提交改动
- 安装包已经重新构建完成

## 标准步骤

### 1. 更新版本号

先把 [package.json](../package.json) 里的 `version` 提到目标版本。

修订号示例：

- `0.1.0 -> 0.1.1`：兼容性不变的小修复
- `0.1.1 -> 0.2.0`：新增功能但兼容旧行为

### 2. 本地构建与预检

```bash
bun run build
bun run preflight
```

`preflight` 会跑 verify、检查 release notes、确认 DMG/app 不比源码旧，并抽查 asar 主路径符号。

构建完成后确认下面文件存在：

- `dist/PromptBox-<version>-arm64.dmg`

以下文件当前不是手动下载安装所必需，只在接入自动更新后再随 Release 上传：

- `dist/latest-mac.yml`
- `dist/PromptBox-<version>-arm64.dmg.blockmap`

### 3. 检查工作区

```bash
git status --short
```

确保只包含本次版本相关改动。

### 4. 提交并推送代码

```bash
git add package.json README.md index.html main.js preload.cjs renderer.js lib tests docs
git commit -m "feat: <本次版本的核心变化>"
git push origin main
```

如果本次只有版本发布相关改动，也可以使用：

```bash
git commit -m "chore: release v<version>"
```

### 5. 创建并推送 Tag

```bash
git tag electron-v<version>
git push origin electron-v<version>
```

示例：

```bash
git tag electron-v0.1.1
git push origin electron-v0.1.1
```

### 6. 创建 GitHub Release

先确保本机已经登录 GitHub CLI：

```bash
gh auth status
```

发布命令：

```bash
gh release create electron-v<version> \
  dist/PromptBox-<version>-arm64.dmg \
  --repo willorn/prompt-box \
  --title "PromptBox v<version>" \
  --notes-file .github/release-notes-<version>.md
```

如果还没有生成单独的 release notes 文件，也可以直接用 `--notes` 或先复制 [.github/RELEASE_TEMPLATE.md](../.github/RELEASE_TEMPLATE.md) 填好再发布。

## Release 内容约定

当前阶段 GitHub Release 默认只上传一个文件：

- `PromptBox-<version>-arm64.dmg`

原因：

- 项目当前没有接入 `electron-updater` / `autoUpdater`
- 用户主要通过 GitHub Release 页面手动下载安装
- `latest-mac.yml` 和 `blockmap` 目前不会被应用读取

如果后续接入自动更新，再把以下文件加入 Release：

- `latest-mac.yml`
- `PromptBox-<version>-arm64.dmg.blockmap`

## 发布前检查清单

- 版本号已更新
- `bun run build` 成功
- `dist/PromptBox-<version>-arm64.dmg` 已生成
- 工作区干净
- `main` 已推送
- Tag 已推送
- GitHub Release 已创建
- Release 附件可下载

## 备注

- 当前构建产物未签名，macOS 首次打开可能会出现安全提示
- 只有 Apple Silicon `arm64` 安装包属于当前正式流程的一部分
