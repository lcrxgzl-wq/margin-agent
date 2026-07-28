# 发布 Runbook

包：`margin-agent`（npm 公共 registry，`apps/cli`）。首发 0.1.0。

## 一次性准备

1. npm 账号：已开启 passkey/安全密钥 2FA；手动发布必须使用用户自己的真实 TTY。
2. GitHub：仓库已建（public）。首个版本发布后，到 npm 包设置 → Trusted Publisher 绑定本仓库 + `.github/workflows/publish.yml`，之后 tag 发布走 OIDC，本机不再存任何 npm 凭证。

## 每次发布

```bash
cd apps/cli && npm version patch --no-git-tag-version && cd ../..  # 或 minor
pnpm build && pnpm test && pnpm typecheck
pnpm gate:release && pnpm gate:install
# Windows x64：同时验证并生成便携 ZIP
pnpm gate:portable:win
```

### 手动兜底（真实 TTY + passkey）

```bash
npm login                                # 浏览器 + 安全密钥授权
cd apps/cli && npm publish               # 必须在用户自己的真实终端执行
npm view margin-agent                    # 验证已上线
```

日常发布优先使用下方 Trusted Publisher 自动管线。

### 之后（0.1.1+，OIDC 自动）

```bash
git add apps/cli/package.json
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

tag 推送触发 `.github/workflows/publish.yml`：全部门禁（test/typecheck/build/gate:release/gate:install）→ `npm publish --provenance` → Windows x64 便携包门禁 → 创建 GitHub Release 并上传 ZIP 与 SHA-256。Actions 页面绿灯即发布完成。

## 验证用户安装

Windows x64 便携版：从 GitHub Release 下载 `margin-agent-win-x64-vX.Y.Z.zip`，核对同名 `.sha256`，解压后双击“Start Margin.cmd”。该包自带 Node.js，不依赖系统 npm。

```bash
npm i -g margin-agent
cd /path/to/论文目录 && margin-agent
```

终端打印带 token 的 URL，浏览器打开即可。

## 规则

- 版本号只升不降；patch=每轮重构修复，minor=里程碑（见 ROADMAP.md），major=破坏性变更。
- 发布前 `git status` 必须干净；`imports/`、`.margin/`、`release/` 等本地产物已被 gitignore。
- publish 失败排查：403=2FA/OTP 问题；403 + trusted publishing=仓库/workflow 名绑定不匹配；EPUBLISHCONFLICT=版本号已存在。
