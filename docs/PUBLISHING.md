# SDK 版本发布

统一入口是仓库根的 `node scripts/release.mjs`，要求 Node.js 22+。六种 SDK 当前版本统一为 1.0.1，分别构建并支持手动显式发布；默认只预演，只有 `--execute` 才执行正式发布。CI 只测试、打包和保留构建产物，不发布任何 SDK，也不推送任何标签。首次账号权限与凭据由发布者准备，脚本不注册账号或申请包名。

| SDK 参数 | 分发平台 / 包名 | 标签约定 | 工具行为 |
| --- | --- | --- | --- |
| php | Packagist `topthink/think-ai` | `v1.0.2` | 显式 publish 推送精确标签并查询 Packagist 索引 |
| python | PyPI `topthink-think-ai` | `python/v1.0.1` | 显式 publish 推送自身标签并上传 |
| typescript | npm `@topthink/think-ai` | `typescript/v1.0.1` | 显式 publish 推送自身标签并上传 |
| go | Go module `github.com/top-think/think-ai/go` | `go/v1.0.1` | 显式 publish 推送精确模块标签并查询 Go 索引 |
| java | Maven Central `com.topthink:think-ai` | `java/v1.0.1` | 显式 publish 推送自身标签并上传 |
| dotnet | NuGet `TopThink.ThinkAI` | `dotnet/v1.0.1` | 显式 publish 推送自身标签并上传 |

表中是标签示例，当前版本由各 SDK 元数据读取。PHP 已有公开 v1.0.0/v1.0.1，不能覆盖已有 v1.0.1；发布新的源码变化需要新的 PHP 版本，例如 v1.0.2。包名是否可用和账号是否有权发布，只有对应平台能最终确认。

六种 SDK 都保留 `prepare`、`build`、`publish` 和只读 `verify`。PHP/Go 正式发布通过推送各自精确版本标签触发平台索引，不上传包文件；索引尚未可见时记录 `index-pending`，可再次查询或重试。`verify` 本身只查询，不创建标签、不上传。

## 常用流程

下面以 Python 下一版 1.0.2 为例，其他语言可替换 SDK 参数使用相同流程。新增 SDK 首发可直接使用当前 1.0.1，无需先升到 1.0.2；PHP 新变化应使用未发布的新版本。

```sh
# 查看当前六种 SDK 的版本与标签命名约定
node scripts/release.mjs status
node scripts/release.mjs check all

# 先查看将修改哪些文件；这一条不写文件
node scripts/release.mjs prepare python 1.0.2

# 确认版本后，同步该 SDK 的元数据、运行时版本、安装示例
node scripts/release.mjs prepare python 1.0.2 --execute

# 审查、提交并推送本次变更（由发布者执行）
git diff
git add python
git commit -m "release(python): 1.0.2"
git push origin HEAD

# 本地测试、独立消费者验收、打包，记录 commit/版本/产物 SHA256
node scripts/release.mjs build python

# 只预演，展示发布命令及缺少的条件，不联网、不打标签、不上传
node scripts/release.mjs publish python

# 在账号凭据准备完成后正式执行：推送单个版本标签并发布
node scripts/release.mjs publish python --execute

# 单独查询公开注册表是否已经能看到该版本
node scripts/release.mjs verify python
```

第一次使用本仓库时，需先提交并推送 SDK 实现和发布工具等全部变更；上面的 `git add python` 只用于之后的单 SDK 升版。脚本不会自动提交、推送分支、改写旧标签或跳过失败的测试。

`prepare` 和六种 SDK 的 `publish` 默认只预演，也可显式加 `--dry-run`。`build` 会实际执行本地测试与打包；`build all` 可依次验收全部语言。`verify` 会联网读取公开版本状态。正式发布一次选择一个 SDK，避免把多个注册表当作一个事务。

首版发布工具接受稳定 `X.Y.Z` 版本，不带 v；预发行版本需要各生态不同的规范化规则，暂不自动映射。Go 0.x/1.x 使用现有 module path，Go 2.x 需先完成 `/v2` 模块路径迁移。

## 构建工具

先按各语言 README 安装开发依赖，发布工具不自动安装系统工具。

| SDK | 构建依赖 |
| --- | --- |
| PHP | PHP、Composer、Python |
| Python | Python 3.11+，`python -m pip install './python[dev,publish]'`；发布额外使用 Twine |
| TS/JS | Node.js 22+、npm，先在 typescript 目录执行 npm ci |
| Go | Go 1.26+、Git、Node.js |
| Java | JDK 17+、Maven、Python、Node.js；发布还需 GnuPG |
| C# | .NET 10、Python、Node.js；直接使用 API key 环境变量发布要求 SDK 10.0.300+ |

工具优先使用 PATH；可配置以下非凭据环境变量：

- `THINKAI_PYTHON`：Python 可执行文件完整路径。仓库内存在 python/.venv 时默认使用它。
- `THINKAI_PIP_PYTHON`：仅用于 bundled Python 缺少 pip 的本地消费者检查，指定另一个提供 pip 的 Python。
- `THINKAI_NPM_CLI`：npm-cli.js 的完整路径；通常自动识别 Node.js 安装中的 npm。
- `THINKAI_COMPOSER_PHAR`：composer.phar 的完整路径。Windows 默认识别 PATH 中 Composer 安装目录的 PHAR，通过 PHP 执行；仓库 .tools/composer.phar 也可自动识别。
- `JAVA_HOME`、`MAVEN_HOME`：Java/Maven 安装目录。Windows 使用 Maven 的 Java bootstrap，避免经 shell 拼接命令；支持 PATH 中的 Maven bin 目录和当前工作区 java/.tools 下的工具。
- `THINKAI_JAVA_SOCKET_DIR`：仅用于本机特殊 Windows 临时 socket 环境；正常机器及 CI 不需要。

## 首次平台准备与凭据

PHP 已有 Composer 包名不变。确认 Packagist 的仓库地址为当前 GitHub 仓库，并配置 GitHub 自动更新 hook。手动正式执行 `publish php --execute` 时，脚本推送精确版本标签并查询 Packagist 是否已索引，不上传 ZIP；尚未可见时保留 `index-pending`，可再次正式执行或使用 `verify php` 查询。[Packagist 自动更新说明](https://packagist.org/about#how-to-update-packages)

Go 的稳定版本依赖公开仓库中的模块版本标签。手动正式执行 `publish go --execute` 时，脚本推送精确模块标签，确认远端标签后查询公共 Go proxy 的版本 .info，以免本地缓存或 GOPRIVATE 配置造成假成功；不上传包文件。索引尚未可见时保留 `index-pending`，可再次正式执行或使用 `verify go` 查询。没有公开版本标签时，不能发布对应的新 Go 稳定版本。[Go 发布流程](https://go.dev/doc/modules/publishing)

其他语言按需准备：

| SDK | 首次准备 | 正式执行读取的凭据 |
| --- | --- | --- |
| Python | PyPI 账号、包名权限；首发 token 需有创建项目权限 | `TWINE_PASSWORD`，脚本使用 token 认证 |
| TS/JS | 有权使用 npm `@topthink` scope；先 npm login 并启用账户 2FA | 默认使用 npm 原生登录；也支持 `NPM_TOKEN` |
| Java | Central 账号、`com.topthink` namespace 权限、可签名私钥及公开公钥 | `CENTRAL_TOKEN_USERNAME`、`CENTRAL_TOKEN_PASSWORD`、`GPG_KEY_ID`；passphrase 可用 agent 或 `MAVEN_GPG_PASSPHRASE` |
| C# | NuGet 账号、包名/前缀权限，API key 允许创建或更新目标包 | `NUGET_API_KEY`，不放入命令行参数 |

PowerShell 7 中可通过隐藏输入设置当前进程的凭据，例如：

```powershell
$env:TWINE_PASSWORD = Read-Host -MaskInput 'PyPI API token'
$env:NUGET_API_KEY = Read-Host -MaskInput 'NuGet API key'

# 仅发布 Java 时需要
$env:CENTRAL_TOKEN_USERNAME = Read-Host 'Central token username'
$env:CENTRAL_TOKEN_PASSWORD = Read-Host -MaskInput 'Central token password'
$env:GPG_KEY_ID = 'YOUR_PRIMARY_KEY_FINGERPRINT!'
# 已解锁 gpg-agent 时可以省略这项
$env:MAVEN_GPG_PASSPHRASE = Read-Host -MaskInput 'GPG passphrase'
```

只设置本次目标平台的变量。不要把真实凭据写进仓库。脚本不会打印 token、把 token 放入 argv，或保存真实 npm token；NPM_TOKEN 模式的临时 npmrc 只含环境变量占位符，执行结束即删除。

npm 本地交互发布优先使用 `npm login --registry https://registry.npmjs.org/` 和 2FA。按 2026-10 的规则，自动化 token 需要目标 scope/package 发布权限及 Bypass 2FA；stage-only token 不能直接 publish。官方已宣布 2027-01 停止 granular token 直接发布新版本，届时应使用交互 2FA 或另行配置 Trusted Publisher/OIDC。本工具不遇错自动切换为 stage，因为 stage 与公开发布是不同操作。[npm token 规则](https://docs.npmjs.com/about-access-tokens/)

Python 使用 [Twine 官方上传流程](https://twine.readthedocs.io/en/stable/)。NuGet 使用支持 NUGET_API_KEY 的官方客户端环境变量，要求 .NET SDK 10.0.300+；本地已核对 SDK 10.0.301 的 NuGet.Commands 实现包含该环境变量。

Java 的 namespace、公钥和签名准备详见 [Java 发布配置](../java/PUBLISHING.md)。统一 CLI 对 manifest 中已验收的四个文件签名、生成校验文件并上传 Central bundle，等待 PUBLISHED；不会在上传前重新构建另一组 JAR。POM 的可选 release profile 保留为独立 Maven 发布方式。[Central Publisher API](https://central.sonatype.org/publish/publish-portal-api/)

## 发布检查与失败恢复

本地构建产物位于 `.artifacts/releases/<sdk>/<version>/build-.../`，manifest 记录版本、commit、dirty 状态和精确产物 SHA256。六种 SDK 手动正式发布必须满足：工作树干净、当前分支 HEAD 已推送到 origin 的实际 push URL、manifest 来自当前已提交代码、版本与运行时一致、产物未被修改、所需凭据齐全。远端权限由平台继续核验。

手动正式执行所选 SDK 的 `publish` 时，脚本只推送该 SDK 的精确标签，显式禁用 push.followTags；已有同 commit 标签可复用，任何指向其他 commit 的同名标签都拒绝。不会用 --force、--tags、skip-existing 或 skip-duplicate 掩盖版本冲突。CI 不调用正式发布，也不执行标签推送。

六种 SDK 的发布进度记录在同版本目录的 `publish-result.json`。标签推送后上传或平台索引查询失败时，不会删除标签或声称已回滚：

- PHP/Go 索引待完成：保留 `index-pending`，修好 webhook 或等待镜像后运行 `verify <sdk>`；也可再次手动正式执行，复用同 commit 标签并查询索引。版本不可见之前，不视为完成。
- Java 已获得 deployment ID：重新正式执行时仅需 Central token，继续查询该 deployment，无需 GPG 私钥且不重新上传；若服务端 FAILED，先在 Portal 核查错误。
- Python/npm/NuGet 上传部分成功或结果不确定：先检查平台实际版本和文件清单；不要直接删除标签重来。脚本不默认跳过已有文件，必要时由维护者确认状态后按平台流程补齐或使用新版本。
- 本地记录已经 published：使用 verify 查询，不再次上传同一版本。

包名可注册性、账号 owner、DNS 权限、签名可验证性和真实 registry 接收结果无法由离线测试证明。本次已运行本地构建/消费者验收及 Mock 发布编排测试，未创建项目远端标签、未进行真实签名或上传；详细结果见 [验收记录](VALIDATION.md#发布工具验收)。
