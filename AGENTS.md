# AGENTS.md — Margin 项目协作指南

## 项目是什么

Margin（npm 包 `margin-agent`）：本地运行的文档修订 Agent。模型对 Word 文档（.docx）的具体选区提出修改提案（Proposal），作者在浏览器画布逐条裁决 Y（接受）/ N（拒绝）/ E（编辑后接受），只有被接受的提案才写入工作副本。原始文件永不被改动；提案、裁决、写入全部记录在本地 SQLite（`.margin/`）。

## 仓库结构

- `apps/cli` — Fastify 服务 + 宿主（margin-agent，唯一发布物）
- `apps/web` — React 19 + Vite 前端（画布、聊天、审阅面板）
- `packages/domain` — Proposal / Decision / ApplyEvent 契约
- `packages/agent` — 会话编排、pi 工具、direct-proposal
- `packages/harness` — 人格/约束/skills（social-science-zh、office-zh、minimal 三档）
- `packages/llm` — BYOK 连接层（OpenAI 兼容 / Anthropic）
- `packages/storage-local` — workspace-fs（安全边界）、office-docx（DOCX 读写）、SQLite
- `brand/` — logo 与品牌资产（草稿在 brand/drafts/）
- `docs/` — EXECUTION_PLAN.md（轮次进度）、RELEASE.md（发布 runbook）、superpowers/{specs,plans}/

## 常用命令

- `pnpm test` / `typecheck` / `build` — 全量门禁（提交前必过）
- `pnpm smoke` — 构建 + golden docx 流水线
- `pnpm gate:release` — 发布包内容校验（esbuild 单文件 bundle）
- `pnpm gate:install` — 安装冒烟（pack → 临时 prefix 全局装 → 启动 → 200）
- `node scripts/ux-walkthrough.mjs "imports/sport value.docx"` — UI 走查（需本机 Edge）
- `node scripts/visual-thread-check.mjs` — 视觉检查
- `pnpm dev` / `pnpm start` — 启动（`MARGIN_PORT`、`MARGIN_NO_OPEN=1`、`--unlimited`）

## 必须知道的坑

1. **两阶段 build**：margin-agent 不能在 manifest 声明 @margin/* 依赖（发布门禁禁止泄漏）。干净克隆必须走 root `pnpm build`（已保证先 @margin/* 后 margin-agent）。测试也依赖 dist 产物——跑 margin-agent 测试前先 build。
2. **混排行尾**：多个源文件是 lone `\r` 混排（workspace-fs.ts、README.md 等）。Edit 工具多行块常匹配失败；可靠做法是临时 node 脚本做字节级编辑（正则容忍 `\r?\n`），用完删除。不要全局重写行尾。
3. **GNU tar**：Windows 下 tar 把 `E:\` 盘符当远程主机，必须 `--force-local`。
4. **npm publish 需要真实 TTY**：账号 2FA 是安全密钥（webauthn，无 TOTP），agent 侧无法模拟（winpty 也不行）。手动发布由用户在自己终端执行 `cd apps/cli && npm publish`；常规发布走 tag 自动管线（见下）。
5. **工作区边界**：`resolveWorkspacePath`（workspace-fs.ts:97）拒绝绝对路径与 `..` 逃逸；读取旁路仅在 `--unlimited` / `MARGIN_UNLIMITED=1` 时开启（密钥黑名单在 realpath 后检查）。**写路径没有任何旁路，不要加。**
6. **canvas-editor 0.9.137**：无原生 track-changes。注入原语 `getKeywordRangeList` → `executeSetRange` → `executeInsertElementList(isSubmitHistory:false)`；禁止 `executeSetValue` 注入；流坐标与元素下标有漂移，用 `probeStreamDrift()` 校正。

## 发布

详见 `docs/RELEASE.md`。日常：`cd apps/cli && npm version patch` → commit → `git tag vX.Y.Z && git push --tags` → GitHub Actions 全部门禁 + OIDC 自动发布（Trusted Publisher：lcrxgzl-wq/margin-agent + publish.yml）。手动兜底：用户 TTY 执行 `npm publish`。

## 工作方式惯例

- 每轮工作：spec（`docs/superpowers/specs/`）→ 实现 → 门禁全绿 → 进度写入 `docs/EXECUTION_PLAN.md`（本地工作文档，已被 gitignore 不入库）。
- **git 变更操作（commit/push 等）每次先取得用户确认。**
- 测试基线：404 全绿（第 61 轮时点）；新功能必须带测试。
- 走查脚本改动 UI 行为后必跑；发版前必跑 `gate:release && gate:install`。
