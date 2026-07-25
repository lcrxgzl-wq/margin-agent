# 发布 Runbook

包：`margin-agent`（npm 公共 registry，`apps/cli`）。首发 0.1.0。

## 一次性准备

1. npm 账号：npmjs.com 注册 → 验证邮箱 → Settings 开启 2FA（Authenticator app）。**不开 2FA 无法发布**。
2. GitHub：仓库已建（public）。首个版本发布后，到 npm 包设置 → Trusted Publisher 绑定本仓库 + `.github/workflows/publish.yml`，之后 tag 发布走 OIDC，本机不再存任何 npm 凭证。

## 每次发布

```bash
pnpm build && pnpm gate:release && pnpm gate:install   # 本地门禁
cd apps/cli && npm version patch                        # 或 minor；改版本号
```

### 首发（0.1.0，手动）

```bash
npm login                                # 2 小时会话，浏览器授权
cd apps/cli && npm publish --otp=<Authenticator 6 位码>
npm view margin-agent                    # 验证已上线
```

首发完成立刻去 npm 包设置配置 Trusted Publisher（见上）。

### 之后（0.1.1+，OIDC 自动）

```bash
cd apps/cli && npm version patch && cd ../..
git add apps/cli/package.json && git commit -m "release: v0.1.1"
git tag v0.1.1 && git push && git push --tags
```

tag 推送触发 `.github/workflows/publish.yml`：全部门禁（test/typecheck/build/gate:release/gate:install）→ `npm publish --provenance`。Actions 页面绿灯即发布完成。

## 验证用户安装

```bash
npm i -g margin-agent
cd /path/to/论文目录 && margin-agent
```

终端打印带 token 的 URL，浏览器打开即可。

## 规则

- 版本号只升不降；patch=每轮重构修复，minor=里程碑（见 ROADMAP.md），major=破坏性变更。
- 发布前 `git status` 必须干净；`imports/`、`.margin/`、`release/` 等本地产物已被 gitignore。
- publish 失败排查：403=2FA/OTP 问题；403 + trusted publishing=仓库/workflow 名绑定不匹配；EPUBLISHCONFLICT=版本号已存在。
