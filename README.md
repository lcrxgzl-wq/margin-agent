<p align="center">
  <img src="brand/logo.svg" width="96" alt="Margin logo">
</p>

<h1 align="center">Margin</h1>

<p align="center">
  <strong>本地优先的 Word 文档修订 Agent</strong><br>
  开源 · 极简 · BYOK · 文稿不出本机
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/margin-agent"><img alt="npm" src="https://img.shields.io/npm/v/margin-agent.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="CHANGELOG.md"><img alt="changelog" src="https://img.shields.io/badge/changelog-0.6.1-informational.svg"></a>
</p>

<p align="center">
  <img src="brand/social-preview.png" width="640" alt="Margin social preview">
</p>

用 AI 辅助写 Word 时，你是否还在对话框和文档之间来回 Ctrl+C / Ctrl+V？或是对着 coding agent 的成块黑盒改动无所适从——它改了什么、为什么改，无法即时查阅、无法逐条反悔？亦或者，你担心未发表的论证在一次次粘贴中被悄悄带离本机？

一组朴素的事实：**文稿的所有权是你的。** 你作为自然人，是文档内容的第一负责人。任何工具对正文的改动，都应该经过你；任何改动文稿的行为，都应该发生在你看得见的地方。

**Margin** 从这一组最小问题出发：运行在你自己电脑上的文档修订 Agent，专为 Word（`.docx`）写作场景设计。它只做一件事——在 AI 时代优化你已形成的文档编辑习惯，作为进入 AGI 时代前的中间方案。

## 提案制，而非覆盖制

Agent 针对你选中的段落给出具体修改，每一处改动以修订标记呈现——改了哪个词、哪句话，修改前后对照一目了然。

- **Y 接受** — 采用这条建议，写入工作副本  
- **E 编辑后接受** — 先改成自己认可的表达，再写入  
- **N 拒绝** — 保留原文  

只有被你接受的提案才会写入工作副本；**原始 `.docx` 不会被改动**。每一次动作记录在工作区本地数据库里，随时可回溯。

调用模型时，只有选区和必要上下文会发送给你自己配置的服务商——**用你的钥匙（BYOK）**，走你的账户，没有任何遥测。服务只监听 `127.0.0.1`。

## 安装

**Windows x64 便携版**（无需 Node / npm / 管理员权限）

从 [GitHub Releases](https://github.com/lcrxgzl-wq/margin-agent/releases) 下载 `margin-agent-win-x64-vX.Y.Z.zip`，解压后双击 `Start Margin.cmd`。自带 Node 运行时；启动器自动挑选空闲端口。默认工作区为「文档\Margin」，也可把论文文件夹拖到启动文件上。

**npm**（Node.js 22+）

```bash
npm i -g margin-agent
cd /path/to/你的论文目录
margin-agent
```

更新：`npm i -g margin-agent@latest`。浏览器会自动打开。在「设置」里配置 OpenAI 兼容或 Anthropic 的 Base URL + Key；未配置时可用离线模式熟悉流程。详见 [`docs/USAGE.md`](docs/USAGE.md)。

## 按需进阶

- **模型**：任意 OpenAI 兼容 / Anthropic 端点；可调推理强度  
- **外读资料**：挂载或粘贴本机路径，一次读入 md / txt / json / csv / pdf / docx（提取文本）  
- **方法（Skills）**：管理写作方法论；聊天框 `@` 按需挂载  
- **会话**：顶栏新建 / 切换 / 清空；上下文用量可见，约 85% 自动压缩，也可手动压缩  
- **多工作区**：一篇文稿一个窗口——`MARGIN_PORT=8788 margin-agent`（便携版自动分配端口）

## 与 miwrite

[miwrite](https://miwrite.art/) 网页工作台里「修改是一条待审建议，而不是一键覆盖」的工作方式，来自本开源项目。Margin 适合要完整本地 Agent、文稿与记录都留在自己电脑上的作者；miwrite 适合浏览器里围绕同一份文稿持续读写、审阅与模块化任务。

- 介绍：[从一份 Word 开始，让 AI 围着文稿工作](https://mp.weixin.qq.com/s/OBZ7VNd4YyCmizITaZVDug)  
- 发布说明：[Margin-agent：Vibe Writing 工作流 · 开源 · 极简 · 本地运行](https://mp.weixin.qq.com/s/9MXSPtXo_J64zqNp0rL6Mw)

## 更新日志

见 [`CHANGELOG.md`](CHANGELOG.md)（自 **v0.6.1** 起维护）。

## 开发

```bash
pnpm install
pnpm test
pnpm mvp   # 或 pnpm start
```

DOCX 是 Word 主路径的规范文件；人的画布编辑需显式保存，Agent 永远不能直接覆盖正文。规划见 `ROADMAP.md` · `MARGIN_PLAN.md`。

## 致谢

Agent 壳基于 [pi](https://github.com/earendil-works/pi)（Mario Zechner，MIT）；DOCX 适配层部分派生自 canvas-editor 生态（见 `THIRD_PARTY_NOTICES.md`）。

开发者：MaskedPalmCivet（落尘如雪） · `lcrx.gzl@foxmail.com`

## 许可

MIT（本地）。云端中转 / 计费为专有，不在本仓库范围。
