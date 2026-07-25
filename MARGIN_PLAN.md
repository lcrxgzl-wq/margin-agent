# Margin（边注）成熟方案 v1.1

> 多子 agent 研讨收敛稿（市场 · 技术 · UX · GTM · 风险批判）  
> 日期：2026-07-18 · 修订：双轨交付定稿（本地完全体 + 云端阉割版）  
> 总判定：**条件性 Go** — 洞察成立；交付形态已定为 Craft OSS 本地 + 收费云中转

---

## 0. 产品宪法（v1.1 定稿）

**用户是领导/导师，Agent 是员工。**领导可以指挥员工写具体一段，也可以指挥员工通读改全篇；员工写完的东西，领导可以撤回（Undo）、自己编辑（Edit），或用一句 vibe 指令要求重写。形态可以是工作台，但审阅权/签字权 100% 在领导手里，Agent 没有 apply 权限。

块级 Y/N/E 是领导签字的交互语法；Agent 是可指挥、可撤回、可被接管的员工，Domain 契约是双方唯一算数的工作记录。护城河是：审稿意见映射 + 证据约束 + 社科 Harness + 人类裁决日志。

### 0.1 双轨交付（已拍板）

| | **本地完全体**（开源） | **云端阉割版**（收费） |
|--|------------------------|------------------------|
| 入口 | `cli` + `localhost` Web | 你的服务器上的 Web |
| 能力 | 全功能：工作区文件、Agent 扫盘/分块、Y/N/E、导出等 | **仅简单功能**（短文/选段建议、基础 Y/N/E） |
| Agent 读本地文件 | ✅ | ❌ **全部阉割** |
| AI | BYOK / 本地 Ollama | **只走你的中转，不提供自填 API Key** |
| 数据 | 默认本机 | **上云**；声称保留 **7 天**（对外写死 7，实现 3–7 天窗口内自动删）；用户可主动删除 |
| 训练 | — | **否**（不用于训练） |
| 收费 | 免费（可选捐赠） | 订阅/按量 |
| 定位 | 作品与完全体 | 图省事的轻量试用/付费便利 |

对外一句话：

> 本地免费、自己带模型、完整 Agent；云端省事、我们出模型，数据在云上最多保留 7 天且可删、不训练，功能为简单改写审阅子集。

### 0.2 本地运行约定

```text
cd 论文工作区
npx margin-agent   # 或 margin-agent
→ 起本机服务 → 自动打开浏览器
→ 终端保持打开；Ctrl+C / 关终端 = 停服务（文件已存盘则不丢）
```

- **不做 Desktop 首发**；需要时再薄壳 Electron。  
- CLI **不是**漂亮审阅 UI，只做启动器 + 无头命令（`scan` / `export`）。  
- 审阅 UI 只在 Web（localhost 或云端）。

### 0.3 开源与商业边界

| 资产 | 许可 |
|------|------|
| 本地 CLI、localhost Web、核心审批协议、Harness schema | MIT（永久） |
| 学科模板规则 | CC0（Verified 标识归商标） |
| 云端账号、计费、中转、存贮、运维 | **专有**，可独立仓库或不开源 `cloud/` |
| 品牌 / Logo | Trademark Policy |

捐赠可选；不承诺 SLA。云端是小生意，本地是作品。

### 0.4 云端功能白名单（简单版）

**允许：** 粘贴/上传单篇短文或选段 → 生成少量修订提案 → Y/N/E → 下载结果文本；账号与配额。

**禁止：** 工作区目录挂载、长文自动分块扫描 Agent、本机工具调用、Zotero/文件系统 Agent、复杂 Word 流水线、批量全篇 Agent。

完全体能力引导：「安装本地版」。

---

## 0.5 一句话判决（研究结论仍有效）

原计划「第一周 Fork Pi」不成立。本地完全体也先跑通红笔循环，再引入 `pi-agent-core`；**不 fork** `pi-coding-agent`。

### 0.6 架构审定与执行文档

- GPT sol 结论：**Go with changes**（强制：能力边界分离、Proposal/Decision/ApplyEvent、localhost 安全、LLM Zod 校验、云端 TTL 可验证）
- 长程规划与里程碑：见 `ROADMAP.md`
- Phase A 代码：`apps/cli` + `packages/*`

---

## 1. 五路共识（已对齐）

| 维度 | 共识 |
|------|------|
| 痛点诊断需修正 | 「CLI 分块不可见」是创始人镜像；社科真实痛是 Word 批注、审稿返修、引用可信、AI 披露焦虑 |
| 白空间 | 「块级批准」本身不空（Word/Lex/PeerReviewAI 已有）；可占的是 **revision packet**（diff + 理由 + 证据 + 风险级 + 审批 + 披露） |
| 对外话术 | 避免「AI = 博士生代写」；改为「AI 起草修改提案，作者与导师保留学术判断」 |
| 绝对不做 | 降 AI 率、一键代写、批量 Accept All、虚构访谈引语/文献 |
| 商业化 | **本地 MIT 免费 + 可选捐赠；收费只在云端阉割版中转**（非 Teams/机构优先） |
| Pi 集成 | **依赖 `pi-agent-core` + 薄 Harness**，不 fork `pi-coding-agent`（本地完全体后期） |
| 编辑器真相 | 编辑器不是产品；审阅协议 + Harness 才是 |
| 交付形态 | **cli+localhost 完全体；云端简单功能；无 Desktop 首发** |

## 2. 关键分歧与裁决

| 分歧 | 市场/风险派 | 技术派 | **裁决** |
|------|------------|--------|----------|
| 首发载体 | Word 插件 / Web→DOCX | Electron + TipTap | **验证期用 Web 原型；PMF 后再 Electron。Word 往返必须进入前 30 天** |
| Markdown | HSS 约 94% 用 Word，MD 是反产品 | MD 作内部格式合理 | **DOCX/OOXML 是 Word 主路径规范文件；MD 仅作旧稿兼容，禁止再作为 DOCX 中间内核** |
| Week-1 | 勿建壳 | propose/apply 闭环 | **Week-1 = 红笔原型 + Harness 盲测，不是桌面壳** |
| 首发场景 | 英文期刊 R&R | 通用论文改稿 | **以 R&R / 导师批注→修订块为黄金路径** |
| 首付费 persona | 硕博学位论文 vs 英刊 R&R | — | **冷启动用「中文社科 + 英刊 R&R / 送审改稿」；学位论文是规模盘，第二波** |

---

## 3. 产品定位（定稿）

### Positioning

> **Margin 是面向社科论文返修的可审计 AI 工作台。**  
> 把审稿意见、导师批注与指定文献，变成逐块、可解释、可批准的修改提案；作者始终决定每一处改动，并导出 Word 修订稿、回复信与 AI 使用披露记录。

### 中英文名

- 英文：**Margin**（需商标 clearance；与 margin.de / 已有 GitHub margin 阅读工具碰撞）
- 中文：**边注**有同名阅读 App，**不宜作为唯一商标**；建议双名或另起可注册中文主品牌（公开大规模传播前先做 CNIPA 9/42 类检索）
- 技术文档可称 **Margin Agent**

### 差异化矩阵（更新）

| 现有工具 | Margin 真正差异 |
|----------|----------------|
| ChatGPT 全文改写 | 提案进队列，必经 Y/N/E；过程可审计 |
| Word 修订 / Copilot | 审稿意见↔段落映射 + 证据约束 + 披露包 |
| Paperpal / Writefull | 不止语言层；论证/方法/质性材料规则 |
| Lex 建议模式 | 学术原生：引用校验、社科 Harness、Word 审稿交付 |
| Obsidian | 单稿线性论文流，非笔记图谱 |
| 通用 Agent CLI | 无 Bash；工具面仅论文域；本地优先可审计 |

### 核心对象：Revision Packet

每个提案不是「改后的字」，而是：

1. before / after（块级）
2. 一句 rationale（默认折叠长推理）
3. 对应的审稿意见 / 导师批注 ID（可空）
4. 证据：用户指定文献 key 或引文库片段（可空）
5. 风险标签：语言 / 结构 / 论证 / 事实新增
6. 裁决：Y / N / E(+edit_distance)
7. 可导出到：Track Changes、回复信行、AI 披露草稿

---

## 4. ICP 与楔子

### 首选 ICP

中文母语、社科（社会/教育/政治/历史/人类/质性或混合方法）硕博或青年教师：

- 正在做 **revise-and-resubmit** 或送审前改稿
- 交付物是 **.docx**
- 已有 ChatGPT/Claude + Zotero + Word 拼装习惯
- 愿为「少漏改审稿意见、可交代、导师看得懂」付费

### 不做首发

- 「一键生成论文」本科大盘
- 高敏田野原始访谈未脱敏场景（早期）
- STEM LaTeX 重用户
- 导师—学生双端协作平台（销售周期过长）

### 90 天楔子

**只打通一条黄金路径：**

```
导入稿件 + 审稿意见/导师批注
  → 拆成修订块（Agent 提案）
  → Y / N / E
  → 导出 Word 修订 + 意见-回应表 + AI 披露草稿
```

北极星指标：**每周完成至少一次「意见 → 审批 → 导出」的项目数**（不是下载量、不是 star）。

---

## 5. 交互语法（定稿）

| 键 | 语义 | 系统 |
|----|------|------|
| **Y** | 按提案采纳 | `accepted_as_proposed` |
| **N** | 拒绝，保留原文 | `rejected`（可选一句理由） |
| **E** | 以提案为草稿，用户改完再提交 | `accepted_with_edits` + edit_distance |

- **禁止批量 Y**；允许批量 N / 跳过
- Diff：**块级双态**，不要 GitHub 字符红绿；一句自然语言改动摘要
- 无全局 Chat；任务挂在「选中块 / 选中意见」
- 术语去 Git 化：采纳修订 / 修订批次 / 改动预览 / 待裁决

### Agent 硬禁令

- 不得生成带引号的虚构访谈原话（只能用 `quote_bank`）
- 不得创建不在文献库中的 citation key
- 不得 `apply` 正文（apply 仅宿主 + approval token）
- 无 Bash / 任意文件写 / 任意网络

---

## 6. 技术架构（验证通过后的目标态）

### ADR 摘要

| 决策 | 选择 | 理由 |
|------|------|------|
| Agent | `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` 薄封装 | 不要 fork coding-agent（Bash/Git/TUI 全是负债） |
| 壳 | **Electron**（非 Tauri） | Pi 是 TS/Node；Tauri 需 Node sidecar，抵消体积优势 |
| 编辑 | **canvas-editor（DOCX）+ TipTap（旧 MD）** | MIT 分页画布承载 Word 主路径；旧格式不阻塞迁移 |
| 存储 | SQLite（提案/历史/审批）+ 原生 DOCX/OOXML（正文） | 审阅元数据不进入 Word 包；段落 apply 精确改 OOXML |
| 导出 | 原生 DOCX 复制/画布显式保存 + OOXML 回归 corpus | 不再做 DOCX→MD→DOCX 往返 |

### 工具面（模型可见）

`get_document_outline` · `list_blocks` · `get_block` · `search_blocks` · `propose_block_edit` · `add_block_comment` · `cite_check` · `style_lint` · `finish_scan`

### 宿主命令（模型不可见）

`apply_block` · `reject` · `rewind` · `export_docx` · `save`

### 块模型要点

- 稳定 `blockId`（UUIDv7 + alias 表处理 split/join）
- 持久化 before/after 全文，不持久化 unified diff / CRDT / Step
- Proposal 状态机：`draft → proposed → accepted|rejected|edited → applied`；冲突 → `conflicted`
- Apply 必须 CAS：`block_id + base_revision + base_hash`

### 包结构（双轨定稿）

```text
E:\margin
├─ apps/
│  ├─ web/                 # Canvas Office 主编辑器 + TipTap 旧 MD 兼容
│  └─ cli/                 # margin-agent：起服务、open 浏览器、无头命令
├─ packages/
│  ├─ domain/              # block, proposal, revision packet（共享）
│  ├─ agent/               # 仅本地完全体；pi-adapter + paper tools
│  ├─ llm/                 # 抽象：LocalProvider(BYOK|Ollama) | CloudRelay(服务端)
│  ├─ storage-local/       # SQLite + 原生 DOCX/OOXML + 旧 MD
│  └─ harness/             # 规则包（本地全量；云端可用极简 subset）
├─ cloud/                  # 可不开源：API、计费、中转、清理任务
├─ templates/              # CC0
└─ docs/
```

---

## 7. 目标架构（v1.1）

```text
                    ┌─────────────────────────────────────┐
                    │           apps/web (同一套 UI)         │
                    │   Revision Queue · Y/N/E · 极简编辑   │
                    └───────────────┬─────────────────────┘
                                    │
              ┌─────────────────────┴─────────────────────┐
              │ mode=local                                │ mode=cloud
              ▼                                           ▼
     apps/cli → localhost HTTP                    cloud/ API (专有)
     ┌─────────────────────┐                    ┌─────────────────────┐
     │ File workspace      │                    │ Upload / paste only │
     │ SQLite              │                    │ DB + object store   │
     │ Agent (pi-core)     │                    │ NO file agent       │
     │ BYOK / Ollama       │                    │ Relay LLM (no BYOK) │
     │ Full harness        │                    │ Simple propose only │
     └─────────────────────┘                    │ TTL 7d + user delete│
                                                │ Billing / quota     │
                                                └─────────────────────┘
```

### 本地请求路径

1. `margin-agent` 绑定工作区目录，监听 `127.0.0.1:8787`  
2. 打开系统浏览器  
3. UI 调本地 API：`list_blocks` / `propose` / `apply`  
4. LLM 经用户 Key 或 Ollama；正文不经你的服务器  

### 云端请求路径

1. 用户登录 → 粘贴/上传短文  
2. API 写入带 TTL 的存储  
3. 服务端用**你的**模型 Key 调上游 → 返回少量提案  
4. Y/N/E 写回会话；导出纯文本/简易下载  
5. Cron：创建超过 7 天的对象与行；用户可随时 DELETE  

### 共享 vs 分裂

| 共享（MIT） | 仅本地 | 仅云端（专有） |
|-------------|--------|----------------|
| `domain` revision packet | `agent` 工具面、工作区 | 账号、计费、中转、TTL |
| Y/N/E 状态机语义 | SQLite、文件 watch | 上传配额、风控 |
| 极简提案 UI 组件 | 全量 harness | 运营后台 |

---

## 8. 路线图（按双轨重排）

### Phase A — 本地红笔 MVP（先做，1–2 周）

- monorepo：`apps/cli` + `apps/web`  
- `margin-agent`：起服 + 自动打开浏览器；关终端即停  
- 粘贴/打开本地 `.md` → 切块 → 调 BYOK 出提案 → Y/N/E → 写回文件  
- SQLite 存提案与裁决日志  
- **不做：** Pi fork、云、Desktop、完美 Word  

验收：自己用真实章节走通一遍；`npx` 可安装叙事写在 README 草稿里。

### Phase B — 本地完全体骨架（随后）

- 工作区目录模式、冲突 CAS、section 扫描队列  
- 接入 `@earendil-works/pi-agent-core`（薄封装）  
- 1 个学科 harness + 禁虚构引用  
- 简易 DOCX 导出（能用即可）  
- MIT 开源 + Sponsors 捐赠链接  

### Phase C — 云端阉割版（本地可用后再做）

- `cloud/`：上传、会话、中转、配额、支付  
- UI `mode=cloud`：隐藏 Agent/工作区入口；文案引导装本地版  
- TTL=7 天清理任务 + 一键删除  
- 隐私页写死：不训练、保留 7 天、可删、无自填 Key  

### Phase D — 可选

- Electron 薄壳、Zotero、更强 Word、英文 README/Show HN  

---

## 9. 开源与商业（v1.1 定稿）

| 资产 | 许可 |
|------|------|
| 本地 CLI / localhost Web / 核心审批 / 导出 | MIT |
| Pi 适配层 | MIT |
| 学科模板 | CC0 |
| **云端中转、计费、存贮、账号** | **专有** |
| 品牌 | Trademark Policy |

**模式：本地 Craft OSS（可捐赠）+ 云端简单付费中转。**

云端定价（待测）：包月额度（次数或字数），不做精细 token 账单首发。

获客：GitHub 本地版案例 → 云端作「懒人入口」；不以降 AI / 代写获客。

---

## 10. 风险 Top 5（按杀伤力）

1. 云端稿件泄露 / 未真正执行 7 日删除 → 定时清理 + 审计日志必须先于收费  
2. 中转被刷穿模型额度 → 账号、配额、速率限制、异常熔断  
3. 被归类为代写 → 云端只做简单建议；叙事强调裁决与本地完全体  
4. 本地无人用、只靠云 → 违背「完全体在本地」；云必须弱、本地必须强  
5. 商标「边注/Margin」碰撞 → 公开传播前 clearance  

---

## 11. 接下来立刻做什么（执行序）

1. **冻结本文 §0 产品宪法**（已写入）  
2. **初始化 monorepo**：`apps/cli`、`apps/web`、`packages/domain`  
3. **实现 Phase A**：localhost 红笔闭环 + BYOK  
4. **隐私/TTL 设计笔记**（为 Phase C 预留表结构：`expires_at`）  
5. **暂缓**：云端收费、Desktop、Pi fork、机构销售  

---

## 12. 对原方案的具体修订对照

| 原方案 | 修订后 |
|--------|--------|
| 痛点 = CLI 不可见 | 痛点 = 审稿返修不可控 + AI 不可审计 |
| Fork Pi / Desktop 首发 | cli+localhost；Pi core 后期薄接入 |
| 商业 = Teams/机构为主 | **云端简单中转收费 + 本地捐赠** |
| 云端 = 完整同构 | **云端阉割；无本地文件 Agent；无自填 Key** |
| 数据策略未定 | **上云保留 7 天、可删、不训练** |
| 产品名 边注 | 展示可用；商标风险仍在 |

---

## 附录：子 agent 角色与模型

| 轨道 | 模型 | 核心产出 |
|------|------|----------|
| 市场分析 | GPT | 条件 Go；ICP；定价；合规 |
| 技术架构 | GPT | ADR；块模型；Week 路线；接口 |
| 社科 UX | Composer | JTBD；Y/N/E；Harness；指标 |
| 风险批判 | Grok | 杀伤点；更薄 MVP；7 天实验 |
| 开源 GTM | GPT | 服务型 open-core；90 天 GTM；命名风险 |

完整原始报告存于 Cursor agent-tools：`final-*.md`。
