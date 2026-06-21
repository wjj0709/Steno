<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="Steno Logo" width="96" height="96" />
</p>

<h1 align="center">Steno · 速记</h1>

<p align="center">
  <strong>本地优先的桌面速记与 Markdown 工作台</strong><br />
  用 Tauri 2、Rust 和 Vue 3 构建。快速捕获，稍后整理，数据留在本机。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white" alt="Vue 3" />
  <img src="https://img.shields.io/badge/Rust-2024-DEA584?logo=rust&logoColor=white" alt="Rust 2024" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform" />
</p>

<p align="center">
  <a href="#项目定位">项目定位</a> ·
  <a href="#功能概览">功能概览</a> ·
  <a href="#应用截图">应用截图</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#技术栈">技术栈</a> ·
  <a href="#项目结构">项目结构</a>
</p>

<p align="center">
  <a href="./README.en_US.md">English</a>
</p>

---

## 项目定位

Steno 是一款面向桌面工作流的本地优先速记应用。它解决的不是"如何写一篇完整文档"，而是"念头出现的那一秒，如何不切换应用就先把它留下来"。

按下全局快捷键后，速记浮窗会出现在当前应用之上。内容会自动保存为本地草稿，之后可以在主窗口、无限画布或 Zen 模式里继续整理，也可以导出为 Markdown 或 HTML。

核心原则：

- **捕获优先**：先记下来，再决定放在哪里。
- **本地优先**：默认不上传笔记、待办或粘贴板内容。
- **Markdown 优先**：编辑体验接近所见即所得，底层仍保存为 Markdown 文本。
- **桌面优先**：托盘、全局快捷键、置顶便签、系统通知和本地文件夹工作区都是一等能力。

---

## 功能概览

| 模块 | 当前能力 |
| --- | --- |
| 快速捕获 | 系统托盘常驻、主窗口快捷键、速记浮窗、自动保存草稿、`#tag` 标签识别 |
| 置顶便签 | 笔记可钉在桌面，多窗口并存，可调尺寸、位置、透明度、颜色和字号 |
| 主工作台 | 自定义标题栏、可折叠侧边栏、功能搜索、笔记列表、标签筛选、右键菜单 |
| Markdown 写作 | ProseMirror Typora 风格编辑器、只读预览、大纲跳转、Zen 模式、图片粘贴入库 |
| 无限画布 | 卡片自由拖拽、滚轮缩放、平移视口、搜索和标签过滤、双击进入 Zen 写作 |
| 本地工作区 | 从本地文件夹创建工作区，扫描 `.md`、`.markdown`、`.txt`，文本条目可转换为工作区文档 |
| 待办 | 主窗口待办管理、今日待办浮窗、状态流转、到期日期、快捷提醒、系统通知 |
| 统计 | 待办活跃度热力图、创建/开始/完成趋势图、范围和状态筛选 |
| 粘贴板 | 文本、链接、代码、图片、文件、富文本历史记录，支持搜索、筛选、置顶、复制、粘贴和图片编辑 |
| 导出 | Markdown 导出含 YAML frontmatter；本地图片可随 Markdown 打包；HTML 导出为独立文件；PDF 通过打印窗口完成 |
| 设置 | 主题、语言、快捷键、浮窗位置、提醒选项、保留天数、数据路径、开机启动 |

默认快捷键：

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+Shift+N` | 呼出或隐藏主窗口 |
| `Ctrl+Shift+M` | 呼出速记浮窗 |
| `Ctrl+Shift+V` | 打开粘贴板 |
| `Ctrl+Shift+T` | 呼出今日待办浮窗 |
| `Ctrl+Shift+F` | 全局功能搜索 |

快捷键可在设置面板中修改。当前快捷键解析主要覆盖 `Ctrl`/`Shift`/`Alt` 加单个字母键的组合。

---

## 应用截图

> 以下截图存放在 [`docs/screenshots/`](./docs/screenshots/)，拍摄规范与逐张清单见该目录的 [说明文档](./docs/screenshots/README.md)。

### 主窗口

统一的桌面工作台，集中承载笔记、画布、粘贴板、待办和统计。

<p align="center">
  <img src="docs/screenshots/main-window.png" alt="Steno 主窗口笔记列表" width="86%" />
</p>

### Markdown 编辑器

ProseMirror 驱动的 Typora 风格编辑器，所见即所得，底层仍是纯 Markdown 文本。

<p align="center">
  <img src="docs/screenshots/markdown-editor.png" alt="Steno Markdown 编辑器" width="86%" />
</p>

### 速记浮窗

在任何应用之上快速记录，停手后自动保存为草稿。

<p align="center">
  <img src="docs/screenshots/quicknote.png" alt="Steno 速记浮窗" width="58%" />
</p>

### 无限画布

把笔记作为空间卡片整理，适合梳理想法、会议记录和项目线索。

<p align="center">
  <img src="docs/screenshots/canvas.png" alt="Steno 无限画布" width="86%" />
</p>

### 粘贴板

文本、链接、代码、图片和文件的统一历史记录，可搜索、筛选、置顶并一键回贴。

<p align="center">
  <img src="docs/screenshots/clipboard.png" alt="Steno 粘贴板历史" width="86%" />
</p>

### 待办

主窗口集中管理任务，今日待办浮窗常驻桌面，支持状态流转、到期日期和提醒。

<p align="center">
  <img src="docs/screenshots/todo.png" alt="Steno 待办管理" width="86%" />
</p>

### Zen 模式

全屏写作视图，保留大纲和基础导出入口。

<p align="center">
  <img src="docs/screenshots/zen-mode.png" alt="Steno Zen 写作模式" width="86%" />
</p>

### 设置面板

集中管理主题、快捷键、浮窗、提醒、隐私边界和本地存储路径。

<p align="center">
  <img src="docs/screenshots/settings.png" alt="Steno 设置面板" width="86%" />
</p>

---

## 快速开始

### 环境要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | `>= 20.19.0` |
| pnpm | `>= 10.5.0`，仓库锁定 `pnpm@11.5.0` |
| Rust | 以 `src-tauri/Cargo.toml` 为准，使用 edition 2024（建议 Rust `>= 1.85`） |

平台依赖：

- **Windows**：MSVC C++ Build Tools、Windows 10/11 SDK、WebView2 Runtime。
- **macOS**：Xcode Command Line Tools。
- **Linux**：按 Tauri 2 官方系统依赖安装 WebKitGTK 等包。

### 安装和开发

```bash
pnpm install
pnpm tauri:dev
```

仅启动前端开发服务器：

```bash
pnpm dev
```

Vite 默认运行在 `http://localhost:21420`，Tauri 开发模式会自动使用这个地址。

### 构建

```bash
pnpm tauri:build
```

生产包输出到 `src-tauri/target/release/bundle/`。

### 质量检查

```bash
pnpm typecheck            # vue-tsc 类型检查
pnpm test                 # Vitest 前端单测
pnpm lint                 # oxlint + eslint
pnpm fmt                  # oxfmt 格式化
cd src-tauri && cargo test    # Rust 单测
cd src-tauri && cargo check   # Rust 类型检查
```

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Tauri 2 |
| 后端 | Rust 2024、tokio、rusqlite、arboard、walkdir、pulldown-cmark |
| 前端 | Vue 3、TypeScript、Vite 7、Pinia |
| UI | Naive UI、UnoCSS、应用级 CSS 变量主题 |
| 编辑器 | ProseMirror Markdown 内核，代码块内嵌 CodeMirror 6 |
| Markdown 渲染 | markdown-it、Shiki、KaTeX、Mermaid、DOMPurify |
| 图表 | ECharts、vue-echarts |
| 国际化 | vue-i18n，内置简中、繁中、英文、日文、韩文、法文、德文 |
| 工程化 | pnpm、Vitest、oxlint、eslint、oxfmt、simple-git-hooks |

编辑器说明：

- `src/components/MarkdownEditor.vue` 是当前通用编辑入口。
- `src/components/markdown-editor/` 是自研 Markdown WYSIWYG 内核（schema、parser、serializer、nodeviews、plugins）。
- 数据写入仍是 Markdown 字符串，编辑态和只读态共享同一套 schema 与序列化逻辑。

---

## 数据目录

Steno 默认把用户数据写入 `~/.steno/`。

| 路径 | 说明 |
| --- | --- |
| `~/.steno/data.db` | SQLite 数据库，包含笔记、设置、粘贴板、工作区索引和待办 |
| `~/.steno/images/` | 粘贴到 Markdown 编辑器中的本地图片 |
| `~/.steno/backup/` | 数据库备份文件 |
| `~/.steno/exports/` | Markdown、HTML 和 Markdown 图片打包导出 |
| `~/.steno/data/logs/` | 运行日志，按日期目录保存，单文件达到阈值后切分 |

完整路径可在设置面板的"存储"区域查看和复制。

---

## 项目结构

```text
steno/
├── src/                              # Vue 3 前端
│   ├── App.vue                       # 按窗口 label 和路由模式分发视图
│   ├── main.ts                       # 前端入口
│   ├── components/
│   │   ├── MainWorkbenchShell.vue    # 主窗口壳层
│   │   ├── FloatingEditor.vue        # 速记浮窗和置顶便签
│   │   ├── MarkdownEditor.vue        # ProseMirror Markdown 编辑器入口
│   │   ├── MarkdownReadSurface.vue   # 只读 Markdown 渲染面板
│   │   ├── Canvas.vue                # 无限画布核心
│   │   ├── DocumentOutlineTree.vue   # 文档大纲树
│   │   ├── WorkspaceTreePanel.vue    # 工作区文件树
│   │   ├── clipboard/                # 粘贴板图片编辑等组件
│   │   ├── writing/                  # 写作模式相关组件
│   │   └── markdown-editor/          # ProseMirror 内核
│   ├── views/
│   │   ├── MainView.vue              # 笔记列表
│   │   ├── NoteEditorView.vue        # 主窗口笔记编辑
│   │   ├── CanvasView.vue            # 画布页面
│   │   ├── ClipboardView.vue         # 粘贴板历史
│   │   ├── TodoView.vue              # 待办管理
│   │   ├── TodoQuickPanel.vue        # 今日待办浮窗
│   │   ├── StatsView.vue             # 待办统计
│   │   ├── ZenMode.vue               # Zen 写作
│   │   ├── SettingsView.vue          # 设置面板
│   │   └── PrintView.vue             # 打印和 PDF 另存窗口
│   ├── stores/                       # Pinia stores
│   ├── composables/                  # Vue 组合式函数
│   ├── utils/                        # Markdown、图片、预览等工具
│   ├── i18n/                         # 多语言文案（简中/繁中/英/日/韩/法/德）
│   ├── theme/                        # 主题与应用级 CSS 变量
│   ├── styles/                       # 全局样式和 Markdown 渲染样式
│   ├── plugins/                      # 前端插件注册
│   └── types/steno.ts                # 前端 IPC DTO 镜像
│
├── src-tauri/                        # Rust 后端（分层架构）
│   ├── src/
│   │   ├── lib.rs                    # Tauri Builder 和插件注册
│   │   ├── main.rs                   # 可执行入口
│   │   ├── app/                      # 窗口与系统集成
│   │   │   ├── window_manager.rs     # 多窗口管理
│   │   │   ├── quicknote.rs          # 速记浮窗
│   │   │   ├── shortcut.rs           # 全局快捷键
│   │   │   ├── tray.rs               # 系统托盘
│   │   │   └── logging.rs            # 文件日志
│   │   ├── ipc/commands.rs           # IPC command 边界
│   │   ├── domain/                   # 领域模型
│   │   │   ├── models.rs             # 笔记等 DTO
│   │   │   ├── clipboard.rs          # 粘贴板模型
│   │   │   └── todo.rs               # 待办模型
│   │   ├── data/                     # 持久化与本地数据
│   │   │   ├── db.rs                 # SQLite schema、迁移和数据访问
│   │   │   ├── backup.rs             # 数据库备份
│   │   │   ├── cleanup_scheduler.rs  # 草稿和粘贴板清理
│   │   │   ├── workspace_fs.rs       # 本地工作区扫描和写入
│   │   │   └── sync.rs               # 云同步 trait 与边界（暂未实现）
│   │   └── services/                 # 后台服务
│   │       ├── export.rs             # Markdown 和 HTML 导出
│   │       └── reminder_scheduler.rs # 到期提醒调度器
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── docs/screenshots/                 # README 截图与拍摄清单
├── public/                           # 静态资源
├── build/                            # Vite 插件和构建配置
└── scripts/                          # 项目脚本
```

---

## 当前状态和边界

已落地：

- 托盘、主窗口、速记浮窗、置顶便签和多窗口管理。
- 笔记列表、Markdown 编辑、只读预览、Zen 模式、无限画布。
- 粘贴板历史、待办管理、今日待办浮窗、提醒和统计。
- 本地工作区扫描、文本条目转 Markdown 文档。
- Markdown 和 HTML 导出，本地图片打包导出。
- 多语言、主题、快捷键和存储路径设置。

仍在规划或受限：

- 截图、OCR、翻译目前只有路由和占位能力。
- SQLCipher 数据库加密、敏感内容过滤、应用排除名单仍是设置面板中的规划项。
- 云同步仅保留 trait 和边界设计（`src-tauri/src/data/sync.rs`），当前没有实际同步实现。
- 静默 PDF 文件生成没有跨平台适配器；当前通过打印窗口让用户另存为 PDF。

---

## 相关文档

- [贡献指南](./CONTRIBUTING.md)
- [截图清单与拍摄规范](./docs/screenshots/README.md)
- [English README](./README.en_US.md)

---

## 赞赏支持

如果 Steno 对你的工作流有帮助，可以请开发者喝杯咖啡。

<p align="center">
  <table align="center">
    <tr>
      <td align="center" width="50%">
        <img src="images/weichat.jpg" alt="微信赞赏" width="220" /><br />
        <strong>微信赞赏</strong>
      </td>
      <td align="center" width="50%">
        <img src="images/zhifubao.jpg" alt="支付宝赞赏" width="220" /><br />
        <strong>支付宝赞赏</strong>
      </td>
    </tr>
  </table>
</p>

---

## 许可证

MIT。当前许可证声明以 [package.json](./package.json) 为准。
