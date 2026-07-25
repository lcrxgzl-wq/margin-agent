# Margin Agent（边注）

本地优先的社科论文修订工作台：**CLI 起服务 → 浏览器红笔裁决（Y/N/E）**。  
当前交付的是 **Margin Agent 0.1.0 本地完全体**；云端版本另议。

## 一句话

> AI 只提不可变提案；你按 Y/N/E 裁决；文件与审计留在本机。

## 要求

- Node.js 22+
- pnpm 11+（仓库已用 pnpm workspace）

## 安装（最终用户）

```bash
npm i -g margin-agent
cd /path/to/你的论文目录
margin-agent
```

浏览器打开终端打印的带 token 的 URL（服务只监听 127.0.0.1）。在「设置」里配置 OpenAI 兼容或 Anthropic 的 Base URL + Key（BYOK）；未配置时使用受控离线工具环。详见 `docs/USAGE.md`。


## 快速开始（MVP）

```bash
cd E:\margin
pnpm install
pnpm test
pnpm mvp
```

浏览器：在对话中粘贴 `.docx` 绝对路径 → 原生分页画布编辑/表格 → Agent 提案 → Y/N/E → 应用。  
DOCX 是 Word 主路径的规范文件；Markdown 仅保留旧文稿兼容。人的画布编辑需显式保存，Agent 永远不能直接覆盖正文。
计划与进度：`docs/EXECUTION_PLAN.md` · 验收：`docs/MVP.md`

## 多工作区

每个 CLI 进程只服务一个工作区。需要同时处理两个工作区时，打开两个终端，使用不同路径和端口：

```bash
MARGIN_PORT=8787 pnpm --filter @margin/cli dev -- E:\论文A
MARGIN_PORT=8788 pnpm --filter @margin/cli dev -- E:\论文B
```

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

未设置 Key 时使用受控的离线工具环（仍可走通打开、资料读取和 Y/N/E 审阅闭环）；配置 API 后由模型调度同一套工具。

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

## 许可

MIT（本地）。云端中转/计费为专有，不在本 Phase。
