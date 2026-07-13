# PromptBox - 你的提示词管家

[![Electron](https://img.shields.io/badge/Electron-32.2.0-47848F?logo=electron)](https://electronjs.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3.4-000000?logo=bun)](https://bun.sh/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

一款专为效率而生的桌面提示词管理工具。无论你是 AI 创作者、开发者还是内容运营，它都能帮你快速管理和调用常用提示词。

本项目来源于 https://github.com/fantasyao/prompt-master 。

## ✨ 为什么选择 PromptBox？

| 痛点 | 解决方案 |
|------|----------|
| 每次用 AI 都要重复输入相同的提示词？ | 一键复制，秒级调用 |
| 提示词散落在各处，找不到？ | 标签分类 + 即时搜索 |
| 多台电脑提示词不同步？ | WebDAV 云同步，配置秒迁移 |
| 窗口遮挡工作界面？ | 复制后自动隐藏，焦点自动回归 |

## 🚀 快速开始

### 下载安装

前往 [Releases](https://github.com/willorn/prompt-box/releases) 页面下载最新版本：

- **macOS**: `PromptBox-x.x.x.dmg`
- **Windows**: `PromptBox-x.x.x.exe` (计划中)
- **Linux**: `PromptBox-x.x.x.AppImage` (计划中)

### 从源码运行

```bash
# 克隆项目
git clone https://github.com/willorn/prompt-box.git
cd mac-prompt

# 安装依赖
bun install

# 开发模式
bun run dev

# 打包构建
bun run build
```

## 📖 使用指南

### 基础操作

**使用提示词**
1. 按 `Alt+E` 呼出窗口（或点击托盘图标）
2. 点击需要的提示词卡片
3. 已授权辅助功能时，内容会自动粘贴到当前输入位置；未授权时会先复制到剪贴板并提示授权

### macOS 权限说明

首次使用以下功能时，macOS 可能会要求你授权：

- **自动粘贴**：需要「辅助功能」权限
- **全局快捷键 `Alt+E`**：某些机器上同样可能依赖「辅助功能」权限

建议优先测试打包版 `PromptBox.app`。如果功能未生效，请前往：

`系统设置 -> 隐私与安全性 -> 辅助功能`

确认 `PromptBox` 已被允许控制电脑。

**添加提示词**
1. 点击左下角「新增」
2. 填写名称、选择标签、输入提示词内容
3. 点击保存

**管理提示词**
在任意卡片上右键，或使用右侧预览按钮：
- **置顶** - 将常用提示词置顶显示
- **编辑** - 修改提示词内容
- **删除** - 删除该提示词

### 云同步设置

**开启 WebDAV 同步**
1. 点击右上角「⋯」→「同步与备份」
2. 填写 WebDAV 信息（以坚果云为例）：
   - 服务器地址：`https://dav.jianguoyun.com/dav/`
   - 用户名：你的坚果云邮箱
   - 密码：坚果云第三方应用密码
3. 点击「测试连接」→「立即备份」
4. （可选）开启「自动备份」，设置备份频率

**配置迁移到新电脑**
1. 旧电脑：打开「同步与备份」→ 点击「复制配置」
2. 新电脑：打开「同步与备份」→ 点击「粘贴配置」→ 粘贴剪贴板内容 → 点击「应用配置」
3. 点击「从云端恢复」，所有提示词自动下载

## 🎨 核心特性

### 即点即用
点击任意提示词卡片后，应用会优先尝试自动粘贴到当前输入位置；如果系统权限未授权，则回退为复制到剪贴板并提示用户授权。窗口会自动隐藏，尽量不打断工作流。

### 优雅的苹果风格
没有繁杂的按钮和菜单，界面干净得像原生 macOS 应用。半透明效果、圆润的边角、流畅的动画，每一次交互都是一种享受。

### 右键快捷操作
在任意提示词卡片上右键，弹出快捷菜单：置顶/编辑/删除。默认界面干净简洁，只有需要管理时才显示操作选项。

### 秒级搜索
输入关键词，提示词列表实时过滤。配合标签筛选（左侧边栏），再多提示词也能瞬间找到。

### 多端同步（WebDAV）
- 支持坚果云、Nextcloud 等任意 WebDAV 服务
- 自动备份：设置一次，按配置频率自动备份到云端
- 配置迁移：复制配置 → 新设备粘贴 → 完成，无需重复填写服务器信息

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt+E` | 显示/隐藏主窗口 |
| `Tab` | 从搜索框切换到结果列表 |
| `Esc` | 清空搜索 / 关闭层 / 隐藏窗口 |
| `↑/↓` | 在卡片间切换选中 |
| `Enter` | 搜索框：使用第一条；列表：使用当前选中 |
| `⌘/Ctrl + 1-9` | 快速使用当前可见列表第 N 条 |
| `[` | 收起 / 展开预览区 |

## 🛠️ 技术栈

- **Electron** - 跨平台桌面应用框架
- **Bun** - 高性能 JavaScript 运行时
- **electron-store** - 本地数据持久化
- **webdav** - WebDAV 客户端

## 📁 项目结构

```
mac-prompt/
├── assets/                 # 静态资源
│   └── trayTemplate.png    # 托盘图标
├── docs/                   # 文档
│   ├── CHANGELOG.md        # 更新日志
│   ├── CONTRIBUTING.md     # 贡献指南
│   ├── RELEASE.md          # 发布流程
│   └── WEBDAV.md           # WebDAV 配置说明
├── index.html             # 主界面
├── main.js                # 主进程
├── preload.cjs            # 预加载脚本
├── renderer.js            # 渲染进程
├── package.json           # 项目配置
└── README.md              # 项目说明
```

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！请阅读 [贡献指南](docs/CONTRIBUTING.md) 了解详情。

## 🚢 发布流程

版本发布统一按 [发布流程](docs/RELEASE.md) 执行。

## 📝 更新日志

查看 [更新日志](docs/CHANGELOG.md) 了解版本更新历史。

## 📄 许可证

[MIT](LICENSE) © PromptBox

## 🙏 致谢

感谢所有为这个项目做出贡献的开发者！

---

如果这个项目对你有帮助，请给个 ⭐ Star 支持一下！
