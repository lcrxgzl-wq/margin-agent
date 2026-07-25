# Margin 0.1 验收

## 产品形态

左侧是原生 DOCX 分页画布，右侧是可收起、悬浮或专注模式的 Agent 对话与审阅。

Agent 只提交不可变提案；正文中的改动由人用 Y/N/E 决定。人工画布编辑需要显式保存，Agent 永远不能直接覆盖正文。

Markdown/TXT/CSV 可作为工作区资料或旧稿兼容格式，不是 Word 主编辑内核。

## 启动

```bash
cd E:\margin
pnpm install
pnpm mvp
```

浏览器打开 CLI 打印的 `http://127.0.0.1:8787/#token=...`。

也可以安装发布包后运行：

```bash
npx margin-agent E:\path\to\workspace
```

## 30 秒自检

1. 在对话中粘贴一个 `.docx` 绝对路径，确认左侧出现分页正文和表格。
2. 选中一个段落或单元格文字，使用浮动条的重写、翻译、润色或讨论。
3. 改动先显示为待审阅提案；用 Accept、Undo 或 Edit 后 Save 决定是否写回。
4. 关闭文稿后左侧画布消失；重新打开时只显示实际打开成功的文稿。
5. 在设置中填 Base URL 和 Key，点击获取模型、选择模型、测试连接，确认返回模型列表和延迟。

## 自动化门禁

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm gate:release
pnpm gate:docx
pnpm gate:pi
pnpm gate:office -- "E:\path\paper.docx"
```

`gate:office` 需要 Windows Edge；它验证真实分页画布、表格和保存路径。
