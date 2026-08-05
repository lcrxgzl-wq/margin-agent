# Changelog

本项目自 **v0.6.1** 起在此维护面向用户的更新说明。更早版本见 [GitHub Releases](https://github.com/lcrxgzl-wq/margin-agent/releases)。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.6.1] — 2026-08-05

### 新增

- 对话栏可见的「压缩」控件；设置中说明自动压缩与 256k 自定义模型上限
- SourcePicker 支持粘贴本机绝对路径附加资料（需开启外读）
- 外读中文可操作错误提示（`external-read-errors`）

### 变更

- **资料读取默认一次返回提取全文**（md / txt / json / csv / pdf / docx）；不再默认按 6k/12k 分页。极大文件仍有硬顶截断
- 自动压缩阈值：**约 85%** 上下文用量
- 自定义兼容模型上下文上限：**256k**
- 默认工具回合预算：**40 → 60**（lean 通读等长任务更不易中途打断）
- 工作区列表支持递归 / 扩展名 / 查询；绝对路径目录可先列后读
- 工具读取进度标为「后台」，避免把资料正文整段贴进对话

### 修复

- 设置弹层与聊天区横向溢出、布局挤压等问题

### 说明

- **工作文稿**仍按产品内核：窗口够则全文注入；lean 下用 `blockId` / cursor 分批通读，服务提案定址与 CAS
- **外挂资料**走全文读取，与工作文稿分批协议分离

[0.6.1]: https://github.com/lcrxgzl-wq/margin-agent/compare/v0.6.0...v0.6.1
