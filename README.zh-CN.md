<div align="center">

<img src="assets/readme/hero.svg" alt="Graph AI Workspace 将 Canvas 知识卡片、问题上下文、对话分支与本地 AI Agent 连接起来。" />

# Graph AI Workspace

**面向 Obsidian 的 Canvas-first AI 工作区。**

[![版本](https://img.shields.io/badge/version-0.9.0--beta-7c3aed?style=flat-square)](https://github.com/netting-crypto/graph-ai-workspace/releases)
[![平台](https://img.shields.io/badge/platform-Obsidian%20Desktop-483699?style=flat-square)](https://obsidian.md/)
[![许可证](https://img.shields.io/badge/license-MIT-0891b2?style=flat-square)](LICENSE)
[![CI](https://github.com/netting-crypto/graph-ai-workspace/actions/workflows/ci.yml/badge.svg)](https://github.com/netting-crypto/graph-ai-workspace/actions/workflows/ci.yml)

[English](README.md) · [Releases](https://github.com/netting-crypto/graph-ai-workspace/releases) · [Issues](https://github.com/netting-crypto/graph-ai-workspace/issues)

</div>

> **状态：** 0.9 Beta · 仅支持桌面端 · 数据模型和 Agent 适配器仍在持续演进。

Graph AI Workspace 将 **Canvas 保持为组织和沉淀知识的地方**。Conversation 是探索层：为某一个问题明确选择所需材料，交给 Agent 处理，再决定哪些结果值得写回 Canvas。

## 影片

<video src="https://netting-crypto.github.io/videos/graph-ai-workspace-film.mp4" controls width="100%"></video>

107 秒产品影片，无旁白，全部由屏上文字与动效表达。依次讲清痛点、三条设计原则、画布上的对话与三个按钮（Add to Canvas / Fork / Add + Fork）、分叉规则，以及本地 Agent 接入与权限。

## 为什么不同

许多 AI 笔记工具会把工作区变成聊天记录。Graph AI Workspace 将这两件事分开：

| Canvas | Conversation |
| --- | --- |
| 组织知识、撰写持久笔记、保留卡片之间的关系 | 探索想法、比较答案、沿不同方向继续思考 |
| 长期维护的知识结构 | 可以分支的临时思考层 |
| 只接收你明确写回的内容 | 只使用你明确附加的上下文 |

## 使用流程

<img src="assets/readme/workflow.svg" alt="选择 Canvas 卡片，添加问题上下文，向 Agent 提问，按需创建分支，最后将结果写回 Canvas。" />

1. 在 Obsidian Canvas 中选择文本卡片或文件卡片。
2. 将卡片、文件、文件夹、图片或选中文本添加为本次问题的 **Context**。
3. 选择 Agent、模型、推理级别和权限模式。
4. 提问；当需要探索新方向时，Fork 当前 Conversation。
5. 只有当答案值得沉淀为知识时，才使用 **Add to Canvas**。

## 核心能力

- **Canvas-first 组织方式** — Canvas 是知识结构，不是聊天记录。
- **独立 Conversation** — 一张卡片可以参与多个讨论，一个讨论也可以引用多张卡片。
- **问题级 Context** — 附加材料默认只作用于下一次提问，不会默默绑定整个对话。
- **Conversation Fork** — 从指定位置创建分支，不重复复制整段规范历史。
- **显式写回 Canvas** — 将 Agent 回复写回当前 Canvas，并保留 Markdown 内容和来源关系。
- **流式 Agent 界面** — 在支持的运行时中实时查看推理摘要、答案增量、工具调用、编辑和产物。
- **运行时驱动的控制项** — 从当前 Agent 运行时发现可用模型和推理选项。
- **图片输入** — 当所选 Agent 支持时，可粘贴、拖拽或附加图片。

## 支持的 Agent 运行时

Graph AI Workspace 不内置模型，而是连接电脑上已经安装的本地运行时。

| 运行时 | 集成方式 | 说明 |
| --- | --- | --- |
| **Codex** | Persistent App Server，必要时回退到 CLI | 从 `PATH` 自动发现 `codex`，也可在设置中指定路径 |
| **OpenCode** | ACP，必要时回退到 CLI | 支持时从 ACP 会话获取模型和推理选项 |
| **ZCode** | CLI 适配器 | 实验性功能，主要在 macOS 桌面安装环境中测试 |

不同运行时提供的能力并不完全相同。Graph AI 会尽量进行统一映射，但不会声称拥有底层运行时并不具备的安全约束。

## 安装

### GitHub Release

发布版本后，从对应版本的 Release 下载 `main.js`、`manifest.json` 和 `styles.css`，然后在 Vault 中创建目录：

```text
<Vault>/.obsidian/plugins/graph-ai-workspace/
```

将三个文件放入目录，重启或重新加载 Obsidian，然后在 **设置 → 社区插件** 中启用 **Graph AI Workspace**。

### BRAT

GitHub Release 发布后，可以通过 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加本仓库作为 Beta 插件，然后在 Obsidian 中启用 Graph AI Workspace。

## 首次配置

1. 安装至少一个受支持的 Agent 运行时。
2. 按运行时自己的文档完成登录或模型配置。
3. 打开 **设置 → Graph AI Workspace → Agent Runtime**。
4. 检查可执行文件路径、Provider 默认值和权限模式。
5. 打开 Canvas，通过功能区按钮或命令面板启动 Graph AI。

### 命令

- **Open Graph AI sidebar** — 打开 Graph AI 工作区侧栏。
- **Open Interaction Playground** — 在配置的示例 Canvas 存在时打开它。
- **Refresh Agent runtimes** — 重新检测已安装的运行时和能力。

## 权限与隐私

> **启用本地工具前请先阅读。** 权限标签会映射到当前运行时，但它们不是操作系统级安全沙箱。

- **Read only** — 请求 Agent 不修改项目。
- **Ask before changes** — 当底层运行时支持交互式权限请求时，在修改前询问确认。
- **Allow edits in project** — 允许在当前 Vault 或工作区内编辑。

Conversation 历史、Context 引用、设置和 Agent 会话绑定会保存在 Vault 内本地的 `data.json` 中。该文件被 Git 明确忽略，也不会进入 Release 构建。手动填写的 API key 同样保存在本地状态中。

Graph AI Workspace 不包含自己的遥测服务。向 Agent 或模型发送问题时，问题内容和你提供的 Context 可能会传输给配置的模型 Provider 或本地 Agent。本地 Agent 进程可以按照所选权限模式访问 Vault。处理私人材料前，请先查看相应 Provider 和运行时的隐私政策。

## 开发

要求：**Node.js 20+** 和 npm。

```bash
npm ci
npm run check
npm run build
node --check dist/main.js
```

生产构建输出到 `dist/`：

```text
dist/
├── main.js
├── manifest.json
└── styles.css
```

不要提交 `data.json`、`.env*`、本地 Agent 凭据、私人 Vault 内容、`node_modules/` 或生成的 `dist/`。

## 发布

1. 更新 `manifest.json`、`package.json` 和 `versions.json` 中的语义化版本号。
2. 运行 `npm run release:verify`。
3. 提交修改并创建匹配的标签：

```bash
git tag v0.9.0
git push origin main --tags
```

Release 工作流会校验标签，并将 `main.js`、`manifest.json` 和 `styles.css` 发布为 GitHub Release 资产。

## 参与贡献

欢迎提交 Issue 和 Pull Request。请保持修改聚焦，不要包含 Vault 数据或凭据，并在提交前运行上面的本地检查。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
