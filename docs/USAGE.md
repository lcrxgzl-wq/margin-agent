# Margin 0.1 使用说明

Margin 是本地文档修订 Agent。对话负责理解任务和调用受控工具，画布负责正文与审阅；Agent 不直接 apply 正文。

## 打开文稿和资料

| 操作 | 作用 |
|------|------|
| 在对话粘贴 `.docx` 绝对路径 | 导入为工作副本并打开原生分页画布，原始文件不改 |
| 打开 `path/to.docx` | 打开工作区内已登记的 DOCX |
| 列出文件 | 列出工作区可挂载的 DOCX、Markdown、TXT、CSV 等资料 |
| 读取 `path/to.txt` | 在对话中预览资料，不改变正文 |
| 挂资料 | 本轮把只读资料路径交给 Agent；提案 evidence 会指回资料路径和 hash |

## 修订与审阅

| 操作 | 作用 |
|------|------|
| 选中文字后使用浮动条 | 对单段或单元格选区执行重写、按指令重写、翻译、润色或讨论 |
| 讨论 | 只把选区作为上下文送进对话，不生成正文改动 |
| Accept / Undo / Edit | 接受、撤回或编辑后接受单条提案 |
| 审阅面板 | 查看待审提案、理由、风险、证据和时间线 |
| 导出 Word / revision packet | 导出当前 DOCX 或本地审计包 |

跨段、跨单元格或含换行/Tab 的选区会禁用会破坏格式的直接改写，但仍可讨论；这是保护 Word 结构的安全边界。

## API 设置

设置主流程固定为：

1. 选择 `OpenAI 兼容` 或 `Anthropic`。
2. 填入 Base URL；界面会按协议补齐 `/v1`、`/chat/completions` 或 `/v1/messages`。
3. 填 API Key，或在同一已保存目标上留空复用本机保存的 Key。
4. 点击“获取可用模型”，从返回列表选择模型。
5. 点击“测试连接”查看成功/失败和毫秒延迟。
6. 点击“保存并使用”。

Key 只保存在当前工作区的 `.margin/llm-settings.json`，不会发送到 Margin 服务。更换地址或协议时必须重新填 Key，避免把密钥误发给新主机。未配置时使用受控离线工具环；已配置 provider 请求失败会明确报错，不伪装成成功的离线回复。

## Skill 与 MCP

- 内置 Skill 随发布包提供；可从 `SKILL.md` 导入到当前工作区，大小上限 128 KiB，必须有 `name` 和 `description` frontmatter。
- 工作区 Skill 可以覆盖同名内置 Skill，也可以在扩展面板移除；Skill 只提供方法文本，不获得 shell 或正文覆盖权限。
- MCP 只支持显式配置的远程 HTTP(S) Streamable HTTP 服务；非 loopback 地址携带 Token 时必须使用 HTTPS。
- 连接时只允许保存服务端标记为 read-only 且未标记 destructive 的工具，并保留其输入 schema。当前版本尚无逐次参数确认，因此不会把 MCP 工具交给 Agent 调用；配置可保留，待 Host 确认流程完成后再启用。

## 本地边界

服务只监听 `127.0.0.1`，API 需要启动时生成的 Bearer token。工作区路径、DOCX 大小、写入路径和并发保存均由 Host 校验；原始外部 DOCX 保留在原位置，工作副本写入工作区 `imports/`。

默认允许 agent 通过绝对路径读取工作区外的文本资料（md/txt/json/csv/pdf/docx）。可在设置 → Agent →「工作区外读取」关闭，或设 `MARGIN_UNLIMITED=0`。大小上限与密钥黑名单（`.env`、`.ssh`、`*.pem` 等，大小写不敏感、符号链接解析后判定）仍然生效。写入边界不变：外部文件永远不会变成可写文档，外部 DOCX 仍只能导入工作副本。
