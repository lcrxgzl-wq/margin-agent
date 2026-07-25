# Unlimited 外部读取 设计（第 60 轮）

日期：2026-07-24
状态：已批准（经独立评审精简）

## 背景与目标

Margin 的安全边界把 agent 的所有文件读写限制在启动时指定的工作区根内（`packages/storage-local/src/workspace-fs.ts:97` `resolveWorkspacePath()`）。唯一例外是 `.docx` 绝对路径走「导入工作副本」。

用户需要读取工作区外的资料（如 `E:\academic\spviolence\park` 下的 md/txt），不想每次复制进工作区。本设计提供 **unlimited 读取模式**：启动时显式开启后，agent 可读取任意绝对路径的文本资料；**写入边界不变**，外部 docx 仍只能导入工作副本，全文提案/CAS/审计链零改动。

## 已确认决策

1. 读放开，写仍走工作副本（写入路径一行不动）。
2. 开关只用启动参数/环境变量，不做 Settings 持久开关。
3. 读取范围 = 任意绝对路径 + 密钥黑名单（大小写不敏感、分隔符归一）。

## 设计

### 1. `packages/storage-local/src/workspace-fs.ts`（~50 行）

给现有 `readWorkspaceSource` 增加可选参数 `opts?: { unlimitedRead?: boolean }`：

- 入口检测 candidate 为绝对路径（复用现有 `path.isAbsolute || path.win32.isAbsolute` 判断，workspace-fs.ts:102）：
  - `unlimitedRead` 关 → 抛错：`path is outside workspace; start with --unlimited (or MARGIN_UNLIMITED=1) to allow external reads`。**不改** `resolveWorkspacePath` 现有的 `path escapes workspace` 错误（写路径共用）。
  - 开 → 外部读取分支：
    1. `existsSync` 检查，不存在抛错；
    2. `realpathSync` 解析符号链接；
    3. 若解析后仍在工作区根内 → 归一化为相对路径，走原有工作区逻辑（避免黑名单误伤 `.margin` 相邻文件）；
    4. 黑名单检查（见下），命中抛错；
    5. 必须是普通文件（参照 `assertSingleLinkFile`）；
    6. 之后**全部走现有逻辑**：大小上限、TEXT_EXT 扩展名白名单、PDF/DOCX 文本提取。
- 返回值中 `relativePath` 用绝对路径原样回填，sourceRef（`path#sha256=...&chars=...`）机制自动兼容。
- 黑名单为 module-private 纯函数 `isDeniedExternalPath(p: string): boolean`（~15 行）：
  - 匹配前统一 `toLowerCase()` + `\` → `/`；
  - basename 命中：`.env`、`.env.*`、`id_rsa*`、`id_ed25519*`、`id_ecdsa*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`.netrc`、`.npmrc`、`.pgpass`；
  - 任一路径段为 `.ssh`、`.aws`、`.gnupg`、`.git`、`.margin` → 拒绝。

### 2. `apps/cli/src/chat-agent.ts`（~10 行）

`createWorkspaceBridge()`（chat-agent.ts:183）的 `readText`（chat-agent.ts:200）调用改为：

```ts
readText: (relativePath) =>
  readWorkspaceSource(workspace, relativePath, {
    unlimitedRead: process.env.MARGIN_UNLIMITED === "1",
  }),
```

不改 `openWorkspace` 签名，不动 `Workspace` 类型，不改 packages/agent。

### 3. `apps/cli/src/index.ts`（~8 行）

- argv 扫描 `--unlimited`：从 argv 剔除该 flag 后再取工作区路径（index.ts:147），命中则 `process.env.MARGIN_UNLIMITED = "1"`（环境变量 `MARGIN_UNLIMITED=1` 直接生效，无需解析）。
- 启动日志块（index.ts:1538-1543）在 unlimited 开启时加一行警示：`security: unlimited-read ON (external path reads allowed)`。

### 4. 测试（`packages/storage-local/src/` 新增测试，~70 行）

- 黑名单各模式命中（含 Windows 大小写 `.ENV`、`Id_Rsa`、反斜杠路径）；
- 符号链接指向黑名单文件 → 拒绝；
- 符号链接指向正常外部文件 → 允许；
- 开关关闭时绝对路径 → 专属错误信息；
- 外部 txt 读取成功，relativePath 回填绝对路径；
- 工作区内文件的绝对路径 → 走原工作区逻辑，不受黑名单影响；
- 超限文件、目录、不存在路径 → 拒绝；
- cli 层：bridge.readText 开关透传一个用例即可。

### 5. 文档

`docs/USAGE.md`「本地边界」一节补 `--unlimited` / `MARGIN_UNLIMITED=1` 说明 + 一句提示注入警示（外部资料内容会进入模型上下文，勿挂载不可信来源）。

## 安全不变式

- `resolveWorkspacePath` 一字不动；所有写入/导入/CAS 路径零改动。
- 外部读取永远不变成可写文档；外部 docx 仍只能「导入工作副本」。
- 黑名单在 realpath **之后**检查（防符号链接绕过），且大小写不敏感。

## 非目标（第二阶段再议）

- 外部路径挂资料（涉及 `replaceAttachedSources`、`readSourceExcerpt`、`/api/v1/workspace/source-chunk` 三处缓存/引用解析，~25 行）。
- tool description 告知模型可传绝对路径（需碰 packages/agent `createSessionTools`）。
- meta 接口暴露 + 前端 UNLIMITED READ 徽标。

## 门禁

`pnpm test && pnpm typecheck && pnpm build` 全绿。
