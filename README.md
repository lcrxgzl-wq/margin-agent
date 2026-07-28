<p align="center"><img src="brand/logo.svg" width="120" alt="Margin logo"></p>
<h1 align="center">Margin</h1>

Margin 是一个在本地运行的文档修订 Agent，面向以 Word（.docx）写作的论文作者。

## 解决的问题

用大语言模型修改论文时存在三个问题：模型通常直接输出改写后的全文，作者难以逐条核对改了什么、为什么改；修改过程没有记录，无法回溯；文稿经过第三方云端服务时存在数据外流的顾虑。

## 工作方式

Margin 将模型的每次修改限定为一条针对具体选区（一句话、一个段落或一个表格单元格）的修改提案，提案附修改理由与依据。作者在浏览器的文档画布上逐条审阅，选择接受（Y）、拒绝（N）或编辑后接受（E）；只有被接受的提案才写入文档的工作副本，原始文件不被改动。提案、裁决与写入操作全部记录在本地数据库中，可按时间线回看。

模型 API 由使用者自行配置（OpenAI 兼容或 Anthropic）。文稿与运行记录均保存在本机，不经过其他服务器；未配置 API 时可使用离线模式熟悉操作流程。

## 要求

- Windows x64 便携版：无需安装 Node.js 或 npm
- npm 安装：Node.js 22+
- 源码开发：Node.js 22+、pnpm 11+

## 安装（最终用户）

Windows x64 用户可从 [GitHub Releases](https://github.com/lcrxgzl-wq/margin-agent/releases) 下载
`margin-agent-win-x64-vX.Y.Z.zip`，解压后双击“Start Margin.cmd”。程序自带 Node.js；默认工作区是“文档\\Margin”，也可把论文文件夹拖到启动文件上。更新时替换程序目录即可，工作区与 `.margin` 记录不会被删除。

已安装 Node.js 22+ 的用户也可使用 npm：

```bash
npm i -g margin-agent
cd /path/to/你的论文目录
margin-agent
```

浏览器会自动打开（服务只监听 127.0.0.1）。在「设置」里配置 OpenAI 兼容或 Anthropic 的 Base URL + Key（BYOK）；未配置时使用离线模式。详见 `docs/USAGE.md`。


## 快速开始（MVP）

```bash
cd E:\margin
pnpm install
pnpm test
pnpm mvp
```

使用：在对话中粘贴 `.docx` 绝对路径导入 → 画布中编辑或选中文字 → Agent 给出修改提案 → Y/N/E 裁决后应用。  
DOCX 是 Word 主路径的规范文件；Markdown 仅保留旧文稿兼容。人的画布编辑需显式保存，Agent 永远不能直接覆盖正文。
长期规划：`ROADMAP.md` · 验收标准：`docs/MVP.md`

## 多工作区

每个 CLI 进程只服务一个工作区，默认监听 8787 端口。需要同时处理两个工作区时，打开两个终端，指定不同端口：

```bash
MARGIN_PORT=8787 margin-agent E:\论文A
MARGIN_PORT=8788 margin-agent E:\论文B
```

启动时报 `EADDRINUSE: address already in use 127.0.0.1:8787`，说明 8787 已被占用——通常是已有一个 margin-agent 实例在运行（检查已打开的终端窗口），或上一个进程尚未退出。关掉它，或按上面方式换个端口。便携版启动器会自动挑选空闲端口，无需处理。

## BYOK

```bash
# OpenAI 兼容
set OPENAI_API_KEY=sk-...
set MARGIN_MODEL=gpt-4o-mini

# 或 Ollama
set MARGIN_BASE_URL=http://127.0.0.1:11434/v1
set MARGIN_API_KEY=ollama
set MARGIN_MODEL=llama3.1
```

未配置 Key 时以离线模式运行（仍可完成导入文档、读取资料和提案审阅的完整流程）；配置后由模型处理对话与提案生成。

## 数据位置

工作区内：

```text
.margin/margin.db      # 提案 / 裁决 / 应用事件
.margin/backups/       # 应用前备份
.margin/workspace.lock
imports/*.docx         # 外部 Word 原件的工作副本（原文件不修改）
```

真实 Word 画布门禁（需系统 Edge）：

```powershell
pnpm gate:office -- "E:\path\paper.docx"
```

## 架构与规划

- 产品宪法：`MARGIN_PLAN.md`
- 长程里程碑：`ROADMAP.md`（经 GPT sol 审定：**Go with changes**）

## 致谢

Agent 壳基于 [pi](https://github.com/earendil-works/pi)（Mario Zechner，MIT）构建；DOCX 适配层部分派生自 canvas-editor 生态（见 `THIRD_PARTY_NOTICES.md`）。

## 许可

MIT（本地）。云端中转/计费为专有，不在本 Phase。
