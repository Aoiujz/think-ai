# 多语言 SDK 验收记录

日期：2026-10-14（Asia/Tokyo）。本记录区分本地离线协议测试、安装产物验证和未执行的线上验证。

## 本地测试结果

| SDK | 实际运行环境 | 结果 |
| --- | --- | --- |
| PHP | PHP 8.1.12、Composer 2.10.3 | 原版与迁移版各 37 方法、275 项断言通过；18 个源码文件在 Git 换行规范化后完全一致 |
| Python | Python 3.12.14、HTTPX | 90 项测试通过，包含同步和异步客户端及运行时版本检查 |
| TS/JS | Node.js 22.22.3 | 52 项测试通过；ESM、CommonJS、两套声明构建通过 |
| Go | Go 1.27.0 | 全量 go test、go vet、实际模块下载及消费者构建通过 |
| Java | JDK 17.0.20.1、Maven 3.10.0 | 18 项 JUnit 测试通过；mvn verify 通过 |
| C# | .NET SDK 10.0.301 | 19 项 xUnit 测试通过；Release 构建零警告、零错误 |

五种新增 SDK 均使用公共 14 资源、37 方法清单及本地 HTTP 服务验证实际请求。覆盖 JSON、空成功响应、Bearer、扩展参数、递归 GET 查询、multipart、下载、原生 Chat/Responses/Audio SSE、任务查询和 Avatar 等待。

新增边界验证包括跨字节 UTF-8、CRLF、多行 data、注释、DONE、无效 JSON、缺失 DONE、中途断流、HTTP 失败、事件内业务错误、任务 fail、取消、空闲流与缓存数据超时、原任务 ID 及非空对象数组文件参数。

共享事件样例已与服务端公开协议核对：Chat 是顶层 delta，Responses 的 chunks 是含 index 的对象，stats 含 usage/latency；Audio 使用 MIME type、逐块 Base64 和最终统计事件。下载 application/json 文件保留原始空格和换行，不进行 API JSON 解码。

## 安装产物验证

| 产物 | 实际检查 |
| --- | --- |
| PHP Git ZIP | 从当前工作文件建立临时 Git 快照并执行 git archive；仅包含 PHP 与必要元数据，在临时项目中通过真实 Composer dist 安装，14 资源自动加载通过 |
| Python wheel / sdist | 分别安装到两个全新 venv，从源码目录外加载安装后的包；许可、包清单及导入通过 |
| npm tarball | 实际 npm 安装后运行 ESM/CJS 消费者，编译 .mts/.cts 类型消费者；无源码和测试目录混入 |
| Go module ZIP | 临时 Git 仓库、本地 Git HTTP、临时 go/v0.1.0 标签下执行真实 go mod download；PHP archive 排除 Go，Go 下载仍完整，独立消费者构建通过 |
| Java JAR | 主包、sources、javadoc 构建通过；安装到本地 Maven 仓库后由独立消费者按坐标依赖，验证 JSON/SSE/文件原始字节 |
| NuGet | 从本地 feed 安装到独立 PackageReference 消费者，无源码项目引用；验证 JSON/SSE/下载原始字节 |

新增 SDK 各自包含 Apache-2.0 许可，不包含其他语言的 SDK。所有安装验证均使用本地构建产物，没有向公开注册表上传。

## 可复现入口

先按各语言 README 安装构建依赖，再执行：

```sh
composer validate --strict
python tests/php/verify-migration.py
python tests/packaging/php-dist.py
python -m pytest python/tests -q
python python/scripts/check_package.py
npm --prefix typescript test
npm --prefix typescript run check:package
go -C go test ./... -count=1 -timeout=120s
go -C go vet ./...
mvn -B -f java/pom.xml verify
python java/scripts/verify_package.py
dotnet test dotnet/TopThink.ThinkAI.Tests -c Release
python dotnet/scripts/verify_package.py
```

本机 Composer 工具存放在忽略的 .tools/composer.phar，可将 composer 命令替换为 php .tools/composer.phar；PHP dist 脚本使用 `--composer php .tools/composer.phar`。Bundled Python 缺少 pip，消费者脚本支持 `--pip-python` 指定提供 pip 的解释器。

本机 Windows 沙箱默认禁止回环连接，实际 HTTP 测试在允许 localhost 连接的执行环境中运行。Java 本机还需在测试命令传入 `-DargLine=-Djdk.net.unixdomain.tmpdir=D:\My\TOPThink\think-ai\java\.tools\sockets`，消费者使用同路径的 THINKAI_JAVA_SOCKET_DIR；这项环境设置未写入 SDK 产品行为或 CI。

## 发布工具验收

统一发布入口及账号配置见 [发布指南](PUBLISHING.md)。本次实际运行了六个 `node scripts/release.mjs build <sdk>` 入口，均完成本地检查；Python 额外通过 Twine 7.0.0 的 wheel/sdist strict check。产物与 SHA256 manifest 存放在忽略的 `.artifacts/releases/`。当前 SDK 实现和发布工具尚未提交，因此 manifest 明确标记 dirty，正式发布会拒绝使用；提交并推送后需重新构建。

`node --test tests/release/*.test.mjs` 的 39 项离线测试通过，覆盖六语言独立升版、默认预演无文件/网络写入、Windows Composer PHAR 查找、干净工作树和远端 HEAD 检查、精确单标签推送、产物篡改拦截、部分失败记录和恢复。真实临时 Git 仓库用于验证预演不改变 index；正式推送和平台注册表由 Mock 替代。

Java Central 的测试使用 Fake GPG/Fake HTTP 与真实 Python ZIP 打包：四个已验收产物逐字节保留，检查 namespace 路径、签名占位文件、四种校验文件共 24 项，验证上传后先保存 deployment ID，再轮询到 PUBLISHED，以及失败后仅恢复轮询。未使用真实私钥签名，没有把测试 bundle 上传到 Central。

GitHub Actions 新增 Linux/Windows 发布工具检查任务；工作流 YAML 本地解析通过，远端执行仍未验证。

## 明确未执行的验证

- 没有真实 ThinkAI 调用、付费调用或线上模型输出验收。
- 没有公开发布、注册包名、创建远端标签或修改 Packagist 配置。
- GitHub Actions 已配置六语言测试、最低运行时矩阵与安装包检查，但尚未在远端执行；不能把本地结果视为远程 CI 已通过。
- 本地未逐一运行所有最低版本，精确最低版本验收由 CI 矩阵承担。
- Python 的 4 个源码模块已额外通过 Python 3.11 语法级解析检查；这不替代该版本的实际运行测试。
- PHP dist 隔离已通过本地 Git 归档和 Composer 消费验证；未发布后下载远端 GitHub/Packagist 产物。source 安装包含完整仓库，是已确认的设计边界。

附加的 ThinkAI 服务端项目仅作为只读协议依据，工作区状态保持干净。

## 2026-10-15 版本对齐

按维护者要求，以 PHP 的 `php/VERSION` 和已有 `v1.0.1` 标签为基线，将 Python、TS/JS、Go、Java、C# 的当前版本统一为 **1.0.1**。包元数据、运行时版本、npm 锁文件根版本、各语言安装示例和公共发布文档均已同步；六语言版本一致性检查通过。

本次重新验证结果：Python 90 项测试、TS/JS 52 项测试、Java 18 项测试、C# 19 项测试、Go 全量测试与 vet，以及发布工具 39 项离线测试均通过。Python wheel/sdist、npm tarball、Java JAR 和 NuGet 的 **1.0.1** 产物完成独立消费者安装验证；Python 两个产物额外通过 Twine strict check。Go 实际本地模块下载回归通过。

构建日志位于 `.artifacts/version-sync-*.log`，新产物及 SHA256 manifest 位于 `.artifacts/releases/<sdk>/1.0.1/`。本次仅更新本地版本并验收，未创建新标签或公开发布；manifest 仍标记 dirty，正式发布前需提交并推送后重新构建。

## 2026-10-15 CI 改进及手动发布边界

工作流补齐 Java/.NET 的 Python 环境，为生成安装包的五种语言添加 Artifacts 下载，并按分支或 PR 分组取消旧运行。push 只匹配分支；工作流保持 contents:read，所有任务只测试、构建和保存产物，没有 SDK 上传或标签推送步骤。包保留 14 天，名称包含版本与运行时矩阵标识；Go 仅测试源码模块。

`scripts/ci-artifacts.mjs` 按当前元数据版本收集精确产物，复制到新的 staging 目录并附 SHA256 清单，避免混入旧版本、消费者项目和依赖缓存。本地已用五语言的实际 1.0.1 产物验证 staging；NuGet 使用消费者实际安装的包，Java 包含重命名的 POM。CI 上传服务未在远端执行。

六种 SDK 均保留手动发布脚本：`publish` 缺省只预演，显式 `--execute` 才执行发布。PHP/Go 会推送各自精确版本标签，并等待公开索引验证；索引暂不可见时记录 index-pending，允许后续查询或重试。此能力仅供维护者手动执行，CI 不调用发布入口、不创建或推送标签。

全部发布工具与产物收集离线回归 **60 项通过**，包括 PHP/Go 默认预演只读、手动发布前置检查、精确标签推送、同 HEAD 标签复用及索引失败恢复；实际推送和索引请求使用 Mock。本次按维护者澄清恢复手动脚本，CI 文件的 SHA256 与改进完成时一致。工作流通过 actionlint 1.7.12 和结构检查，git diff --check 通过；本次未运行远端 Actions、创建项目标签或公开发布。
