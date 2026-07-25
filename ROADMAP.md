# Margin 长程规划（经 GPT sol 架构审定）

> 日期：2026-07-18  
> 审定结论：**Go with changes**（[架构评审](497da6fa-189f-47e4-bd2c-9c939007b132)）  
> 产品宪法见 `MARGIN_PLAN.md` §0

---

## 1. 审定强制修改（开工前纳入代码）

| # | 改法 | 落地位置 |
|---|------|----------|
| P0 | UI 与能力边界分离：`entry-local` / 未来 `entry-cloud`；`GET /capabilities` | apps/web、API |
| P0 | Revision = 不可变 Proposal + Decision + ApplyEvent | packages/domain |
| P0 | localhost：会话 token、Origin/Host 校验、workspace realpath、CAS、原子写 | apps/cli、storage-local |
| P1 | LLM 输出 Zod 校验 + blockId 白名单；Phase A 不做自治扫描 | packages/llm |
| P1 | 云端 `expires_at` + 可验证删除（Phase C）；DOCX 第 30 天门禁 | cloud/、后续 M4 |

**明确 defer：** TipTap、pi-core、云账号计费、Electron、Zotero、全文 Agent 扫描。

---

## 2. 技术选型（Phase A 冻结）

| 层 | 选型 |
|----|------|
| Monorepo | pnpm workspaces + TypeScript |
| HTTP | Fastify + Zod |
| 前端 | React + Vite + TanStack Query |
| Phase A 编辑 | 块只读 + E 用 textarea（不做 TipTap） |
| Schema | Zod |
| SQLite | better-sqlite3 + Drizzle |
| 文件 | write-file-atomic + proper-lockfile |
| LLM | Vercel AI SDK + OpenAI-compatible（含 Ollama） |
| 测试 | Vitest（领域）+ Playwright（闭环，后续） |

---

## 3. 里程碑 M0–M6（单人约 22 人周）

| ID | 名称 | 验收 | 人周 |
|----|------|------|-----:|
| **M0** | 契约冻结 | Proposal/Decision/ApplyEvent 测试绿；包边界清晰 | 0.5 |
| **M1** | 本地红笔 Alpha | 打开→提案→Y/N/E→应用→重启日志仍在 | 1.5 |
| **M2** | 本地安全骨架 | CSRF/穿越/外部改盘/多实例进入 conflicted 或拒绝 | 3 |
| **M3** | Harness + Agent | pi-core 薄适配；无 Bash；无虚构 citation | 4 |
| **M4** | Word 门禁 | DOCX corpus 核心不丢；损失有报告 | 4 |
| **M5** | 云端私测 | 无本地 Agent 依赖；TTL/删除演练；额度硬上限 | 5 |
| **M6** | 可运营 | 支付/风控/删除 SLO；≥10 真实用户闭环 | 4 |

**M5 启动条件：** ≥10 目标用户中 6 人完成两次本地返修闭环。

### 熔断

- **停云端写入：** 超 7 天仍可访问、删除无法证明、正文进日志、费用打满、跨账号泄露  
- **停云端投入：** 6 周无持续用户、成本>收入 50%、挤占本地/DOCX  
- **停 Agent 复杂化：** Y/N/E 未复用、Agent 增益<15% 且成本×2、非法工具/虚构引用、出现绕过审批  

---

## 4. Phase A = M0+M1（当前冲刺）

目标：`margin-agent` 起 localhost → 浏览器红笔 → BYOK 单块提案 → Y/N/E → 写回 → 审计可重启恢复。

### Day 清单（照做）

- **D1** domain 契约 + monorepo  
- **D2** storage-local：切块、SQLite、路径守卫  
- **D3** CLI + Fastify + token + apply CAS  
- **D4** LLM + 审阅 UI（textarea E）  
- **D5** 导出 packet、README、黄金路径自测  

---

## 5. 本地 API（M1）

| Method | Path | 职责 |
|--------|------|------|
| GET | `/api/v1/capabilities` | local 能力 |
| POST | `/api/v1/documents/open` | 打开工作区内文件 |
| GET | `/api/v1/documents/:id` | 文档元数据 |
| GET | `/api/v1/documents/:id/blocks` | 块列表 |
| POST | `/api/v1/documents/:id/proposal-runs` | 创建提案任务 |
| GET | `/api/v1/proposal-runs/:runId` | 任务状态/结果 |
| GET | `/api/v1/documents/:id/proposals` | 待裁决队列 |
| PATCH | `/api/v1/proposals/:id/decision` | Y/N/E |
| POST | `/api/v1/documents/:id/apply` | CAS 应用 |
| POST | `/api/v1/documents/:id/exports` | 导出 revision packet |

---

## 6. 当前执行状态

- [x] 产品宪法双轨定稿  
- [x] GPT sol 架构审定（Go with changes）  
- [x] 本 ROADMAP 写入  
- [x] **M0** monorepo + domain（Proposal/Decision/ApplyEvent + Vitest 6/6）  
- [x] **M1 / MVP** 最小可用  
- [x] **M2 安全底线** 路径穿越测试  
- [x] **Harness v0 + agent 扫描缝** `@margin/harness` / `@margin/agent`  
- [x] **M3 Paper Agent** 默认 pi+fallback；九工具；Comments 落库；`pnpm gate:pi`  
- [x] **论文 Agent 工作台 P0** 左 TipTap + 右 Chat；pending Accept/Undo；`/legacy` 旧 UI  
- [ ] M4+ Pandoc / 院校模板  
- [x] **短会话记忆** ChatMemory + `smoke:memory`  
- [ ] M3+ 真 Key 下跑通 `gate:pi`（门禁已加强；本机无 Key 时 skip）  
- [ ] M5 云端阉割版  

### MVP 验收（2026-07-18）

见 `docs/MVP.md`。已验证：`GOLDEN_PATH_OK` + 文件列表 + 新一轮 supersede 未裁决提案。

```bash
pnpm mvp
# 或
MARGIN_NO_OPEN=1 pnpm start -- E:\margin
pnpm smoke
# 可选：MARGIN_ENGINE=pi（需 API Key；无 Key 默认 fallback simple）
```

下一阶段：真 Key 跑通 `PI_GATE_OK`、选区定向改写；仍不做云端 / Desktop。
