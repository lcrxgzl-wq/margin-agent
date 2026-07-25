# 正式发布管线 设计（第 61 轮）

日期：2026-07-24
状态：已批准

## 目标

让用户通过 `npm i -g margin-agent` 一条命令安装并运行 Margin；建立 git → GitHub → CI/CD → npm 的可持续发布管线。

## 已确认决策

1. 渠道：npm 公共 registry，包名 `margin-agent`（已验证可用）。
2. 仓库：GitHub public，用 gh CLI 建仓（用户扫码授权一次）。
3. 首发 0.1.0 手动发布（npm login 2h 会话 + OTP）；之后 tag 触发 GitHub Actions OIDC trusted publishing（无 token，--provenance）。
4. `imports/` 加入 .gitignore（用户文稿不进公开仓库）；`fixtures/` 测试素材保留。
5. npm 账号由用户自行注册（免费），强制 2FA（TOTP）。

## 现状地基（已核实）

- `scripts/build-cli-release.mjs`：esbuild 单文件 bundle（@margin/* 经 alias 全部内联，npm deps 保持 external）+ 拷贝 web-dist/skills/README/LICENSE 进 apps/cli。
- `scripts/release-package-gate.mjs`（`pnpm gate:release`）：验 tarball 必备文件、禁带 src/imports/.docx、manifest 无 @margin 泄漏、shebang、bundle 无 @margin imports。
- `apps/cli/package.json`：bin=dist/index.js，files 已裁剪，engines node>=22，prepack=build:release。
- 运行时无原生模块（node:sqlite 内置），全局安装为纯 JS。
- `.gitignore` 已覆盖 node_modules/dist/.margin/.tmp-*/release 等。
- 本地 git 仓库已初始化（master，0 commit，无 remote）；本机无 gh CLI（待装）。

## 设计

### 1. Git 奠基（一次性）

- `winget install GitHub.cli` → 用户 `gh auth login`（device flow 扫码）。
- `.gitignore` 增加 `imports/`。
- 首个 commit（全量代码），`gh repo create margin --public --source=. --push`。
- commit/push 等 git 变更操作执行前逐项向用户确认。

### 2. 包发布就绪改造

- `apps/cli/package.json`：加 `"publishConfig": { "access": "public" }`；补 `repository`/`homepage`/`bugs` 字段（建仓后回填 GitHub 地址）。
- `README.md`：加最终用户段——`npm i -g margin-agent` → 在论文目录运行 `margin-agent` → 浏览器打开终端打印的带 token URL → 设置里配 BYOK。与现有开发者段分开。
- `docs/RELEASE.md`：发布 runbook（门禁顺序、npm login、publish --otp、验证 npm view、tarball 存档、版本 bump 规则）。

### 3. 安装冒烟门禁（`scripts/release-install-smoke.mjs`，新增）

pack tarball → 临时目录 `npm install --prefix <tmp> -g <tarball>` → 以临时工作区启动 `margin-agent`（MARGIN_NO_OPEN=1，随机端口）→ 轮询断言 HTTP 200 且 UI HTML 返回 → 杀进程清理临时目录。挂到根脚本 `gate:install`。失败场景：tarball 缺文件、bin 未链接、启动崩溃——任一即非零退出。

### 4. CI（`.github/workflows/ci.yml`）

push 触发：ubuntu-latest、Node 22、corepack 启用 pnpm → `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm typecheck` → `pnpm build` → `pnpm gate:release`。资源友好，单 job 串行。

### 5. CD（`.github/workflows/publish.yml`）

tag `v*` 触发：CI 全部步骤 + `pnpm gate:install` → `npm publish --provenance`（`permissions: id-token: write`，无 NPM_TOKEN）。首发后在 npm 包设置绑定 trusted publisher（GitHub 仓库 + publish.yml 文件名）。实现时验证 npm 是否支持首发前预配置 trusted publisher；若支持则首发即可走 OIDC。

### 6. 版本节奏

首发 0.1.0；之后每轮重构 patch、里程碑 minor。`npm version` 在 `apps/cli` 目录执行，tag 命名 `v<version>`。

## 安全

- 仓库公开前复查 git status 无敏感文件（.env* 已 ignore，密钥黑名单与发布无关但确认无硬编码 token）。
- OIDC 后本机/CI 均不存长期 npm 凭证；手动首发用 2h 会话 + OTP。

## 非目标（YAGNI）

分支保护/rulesets、GitHub Release 页面、scoped 改名、双 registry、npm 12 allowScripts 适配（包无 install scripts）。

## 验收

1. `pnpm gate:release && pnpm gate:install` 本地全绿。
2. push 后 CI workflow 绿。
3. 用户在干净机器/目录 `npm i -g margin-agent` 成功运行（首发后验证）。
