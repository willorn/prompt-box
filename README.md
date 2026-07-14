# PromptBox · Prompt 快速调用层

[![Electron](https://img.shields.io/badge/Electron-32.2.0-47848F?logo=electron)](https://electronjs.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3.4-000000?logo=bun)](https://bun.sh/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/willorn/prompt-box)](https://github.com/willorn/prompt-box/releases)

> 不是提示词收藏夹，而是全局快捷键唤起的 **Prompt 快速调用层**。  
> 核心价值：在你需要输入时，以最低认知成本，把正确的提示词送进**当前输入框**。

本项目演进自 [fantasyao/prompt-master](https://github.com/fantasyao/prompt-master)。

## 为什么用 PromptBox？

价值链优先级：**唤起速度 > 选择速度 > 执行成功率 > 管理能力**

| 痛点 | 怎么解决 |
|------|----------|
| 记不住好 prompt | 置顶 / 最近 / 多词搜索 + 相关度排序 |
| 找得到但拿不快 | `Alt+E` 唤起 → 1–9 / Enter 一击即用 |
| 找到了还要手动粘贴 | 自动切回前台应用并 Cmd+V；失败仍保留剪贴板 |
| 管理时打断工作流 | 草稿保护；管理图标退后；成功路径尽量静默 |

## 下载安装

前往 [Releases](https://github.com/willorn/prompt-box/releases) 下载：

- **macOS (Apple Silicon)**：`PromptBox-0.3.0-arm64.dmg`
- **Windows / Linux**：计划中

当前安装包未签名。首次打开若被拦截：系统设置 → 隐私与安全性 → 仍要打开。  
自动粘贴还需：**系统设置 → 隐私与安全性 → 辅助功能 → 允许 PromptBox**。

## 30 秒上手

1. 安装后应用默认**后台待命**（可托盘退出）
2. 按 **`Alt+E`** 唤起（冲突时可在系统菜单切换/固定快捷键）
3. 直接打字搜索，或 ↑↓ / 1–9 选择
4. **单击 / Enter**：复制并尽量自动粘贴到刚才的前台应用  
   **Shift+单击 / Shift+Enter**：只复制，不隐藏窗口
5. Esc 分层退场：关层 / 清搜索 / 重置分类 / 隐藏

成功粘贴或仅复制时**不弹成功 toast**（窗口会藏、或卡片轻闪）；失败 / 缺权限时才提示，并可 ⌘V。

## 从源码运行

```bash
git clone https://github.com/willorn/prompt-box.git
cd prompt-box
bun install
bun run dev          # 开发
bun run verify       # 语法 + 单测 + 调用主路径符号守卫
bun run build        # 打 macOS arm64 包
bun run preflight    # 发版预检（含 asar / 产物新鲜度）
```

## 使用说明

### 调用（主路径）

- 唤起后默认选中可见**第一名**；空搜索时 `1–9` 对应列表第 N 条
- 有搜索词时用 `⌘/Ctrl+1–9`；⌫ 改搜索，不误删条目
- 粘贴成功后约 **2.8 秒**恢复原剪贴板（仍是本次内容时；再次粘贴会取消上次恢复）
- 预览可收起 `[`，列表更密；侧栏可收起 `]`

### 管理（次路径）

- **新增**：顶栏「新增」或 `⌘N`（侧栏收起同样可用）
- **编辑 / 置顶 / 删除 / 分享**：右键卡片，或预览区图标按钮（悬停看说明）
- **未保存草稿**：不会被再次唤起 / 托盘 / 切条目静默冲掉
- **导入导出**：系统菜单；支持拖入 JSON / Markdown / CSV；替换可撤销
- **WebDAV**：自动备份与恢复；配置可复制迁移
- **登录时启动**：系统菜单或托盘

### 权限（macOS）

| 能力 | 权限 |
|------|------|
| 自动粘贴 | 辅助功能 |
| 全局快捷键 | 部分环境也依赖辅助功能 |

建议优先测**打包版** `PromptBox.app`。开发模式请给 **Electron**（不是 PromptBox）开辅助功能。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt+E`（可切换） | 显示/隐藏；系统菜单可切换候选，回退时可一点固定 |
| 直接打字 / `/` / `⌘K` / `⌘F` | 搜索 |
| `⌘⌫` | 清空搜索 |
| `Tab` / `⇧Tab` | 搜索 ↔ 列表 |
| `Esc` | 关层 → 清搜索 → 重置分类 → 隐藏 |
| `↑↓` `PgUp/PgDn` `Home/End` | 列表导航 |
| `Enter` | 使用选中（无选中则第一名） |
| `Shift+Enter` / `Shift+单击` | 仅复制 |
| `1–9` | 空搜索时用第 N 名 |
| `⌘1–9` | 任意时候用第 N 名 |
| `E` / `P` / `Delete`·`⌫` | 编辑 / 置顶 / 删除（空搜索） |
| `⌘N` | 新增 |
| `⌘Z` | 撤销删除或替换导入 |
| `[` / `]` | 预览 / 侧栏折叠 |
| `⌘,` | 系统菜单 |
| `⌘⇧L` | 主题 |

完整列表以应用内「快捷键说明」为准。

## 技术栈与结构

- **Electron** · **Bun** · **electron-store** · **webdav**

```
prompt-box/
├── assets/                 # 图标与托盘
├── docs/                   # 哲学 / 架构 / 发布 / WebDAV
├── lib/                    # 纯函数（搜索、导入导出）
├── tests/                  # 单测 + call-path 冒烟
├── scripts/                # verify / preflight
├── index.html              # UI
├── main.js                 # 主进程（快捷键 / 粘贴 / 托盘）
├── preload.cjs
├── renderer.js
└── package.json
```

产品设计见 [产品哲学](docs/PRODUCT_PHILOSOPHY.md) 与 [信息架构](docs/PRODUCT_ARCHITECTURE.md)。

## 发布

按 [发布流程](docs/RELEASE.md) 执行。当前正式产物：

- Tag：`electron-v<version>`
- 附件：`dist/PromptBox-<version>-arm64.dmg`（仅 arm64）

## 更新日志

见 [CHANGELOG](docs/CHANGELOG.md)。

## 贡献

欢迎 Issue / PR。请阅读 [贡献指南](docs/CONTRIBUTING.md)。

## License

[MIT](LICENSE)
