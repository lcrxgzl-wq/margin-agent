---
name: fill-table-from-csv
description: 从工作区 CSV 做声明式汇总，经 resultRef 绑定填入论文表格提案。用于「跑数据填表」。
packs: data-analysis
---

# 从 CSV 填表

何时使用：用户要求按数据算均值/计数等并填进文稿表格或段落数字。

## 步骤

1. `inspect_tabular_file` 确认列名与类型。
2. 口径不清时先问用户（分组列、缺失值）。
3. `run_table_analysis` 用声明式 plan（禁止手算、禁止编造）。
4. `get_analysis_result` 取 `resultRef`。
5. `propose_block_edit_from_results`：模板用 `{{token}}`，bindings 指向 resultRef；数字由宿主填入。
6. 等人 Accept；不要 `write_workspace_file` 覆盖正文。

## 不做

- 不运行 bash / Python / SQL 字符串。
- 不把手写数字冒充计算结果。
