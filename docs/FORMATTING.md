# 代码格式

格式整理覆盖五种新 SDK 的源码、测试及开发脚本。公开接口、协议字段、默认值、运行时依赖和版本保持原样。PHP 源码沿用现有风格，并继续通过迁移兼容性检查。

根 `.editorconfig` 设置 UTF-8、LF、尾部换行及缩进，不设置 100 列上限。Java、Python、C# 使用 4 空格，TypeScript / JavaScript 使用 2 空格，Go 使用 gofmt 的制表符缩进。普通函数定义及调用的参数列表保持单行；控制语句、非空方法体，以及参数中的对象、回调或多行字符串保留各自的内部结构。Go 遵循 gofmt。

独立的链式调用每个方法一行，各次调用的参数不拆分，例如：

```java
var builder = HttpRequest.newBuilder(uri)
        .timeout(operationTimeout)
        .header("Authorization", "Bearer " + token)
        .header("Accept", "application/json");
```

参数内嵌套的调用链保留单行，例如 `send(builder.method(x).build(), options)`，避免为了拆开内层链而把外层普通实参拆到多行。属性访问本身不作为方法调用拆分。

Java 控制流和非空方法体展开，例如：

```java
if (response.statusCode() >= 400) {
    throw new ThinkAIException("HTTP error", response.statusCode(), body);
}
```

## Java

固定 Spotless Maven Plugin 3.10.4，Java 使用 Eclipse JDT 4.26 与 `java/eclipse-formatter.xml`，四空格缩进。参数列表关闭自动拆分并合并已有换行；selector 使用 `WRAP_NEXT_PER_LINE`，强制后续方法各占一行，保留首个调用、控制块和方法体结构。参数内嵌链使用局部 `@formatter:off/on` 保持单行，测试中按相邻断言收拢范围。Spotless 同时整理 `pom.xml`，XML 设置位于 `java/xml-format.properties`。使用 JDK 17，在仓库根执行：

```sh
mvn -B -f java/pom.xml spotless:apply
mvn -B -f java/pom.xml spotless:check
```

格式检查只在 CI 的 JDK 17 任务执行；JDK 17 / 25 都继续执行编译、测试和安装包检查。格式目标没有绑定到普通 Maven 构建生命周期。

## Python

开发依赖固定 Ruff 0.17.0，设置位于 `python/pyproject.toml`。参考行宽为 1000，并开启 `skip-magic-trailing-comma`，避免已有尾逗号导致普通参数列表强制竖排。在仓库根执行：

```sh
python -m pip install './python[dev]'
python -m ruff format --config python/pyproject.toml python java/scripts dotnet/scripts tests/php tests/packaging scripts/central-bundle.py
python -m ruff format --check --config python/pyproject.toml python java/scripts dotnet/scripts tests/php tests/packaging scripts/central-bundle.py
```

这里只使用格式功能；不执行语义 lint 自动修复，也不格式化 docstring 中嵌入的其他语言代码。Ruff 没有独立的方法链换行选项，已展开的链使用局部 `# fmt: skip` 保留。

## TypeScript / JavaScript

开发依赖固定 Prettier 3.9.10、ESLint 10.12.0、ESLint Stylistic 5.10.0 与 TypeScript 解析器 8.71.2。格式工具使用 Node.js 22.13+ 或 24+，SDK 运行时仍为 Node.js 22+。参考行宽为 1000，普通参数列表不再因超过 100 列而拆分；对象和回调代码块仍保留内部换行。在仓库根执行：

```sh
npm --prefix typescript ci
npm --prefix typescript run format
npm --prefix typescript run format:check
```

命令覆盖 SDK 的 `.ts`、测试与包检查脚本，以及根 `scripts/`、共用契约服务、发布工具测试中的 `.mjs`。生成目录、依赖及本地工具目录不参与格式化。

统一入口 `typescript/scripts/format.mjs` 先应用 Prettier，再应用 `typescript/eslint.config.mjs` 中的链式换行和缩进规则；`--check` 在内存中计算相同结果并比对，不写入源码。链式规则复用官方 Stylistic `newline-per-chained-call`，仅过滤位于外层实参中的链，不启用语义 lint 或其他自动修复。编辑器同时使用 Prettier 与该 ESLint 配置，以统一命令的输出为准。

Prettier 会固定拆分带参数属性的 TypeScript 构造函数；SDK 的三处构造函数使用局部 `prettier-ignore` 保持签名单行，方法体仍按正常块结构编写。

## C#

使用 .NET 10 自带的 dotnet format，C# 设置位于 `dotnet/.editorconfig`。普通方法签名及调用参数保持单行，调用链按方法分行，成员间保留空行，控制语句使用大括号并展开。格式工具保留已有的链式换行。先还原依赖，然后在仓库根执行：

```sh
dotnet restore dotnet/TopThink.ThinkAI.Tests/TopThink.ThinkAI.Tests.csproj
dotnet format whitespace dotnet/TopThink.ThinkAI/TopThink.ThinkAI.csproj --no-restore
dotnet format whitespace dotnet/TopThink.ThinkAI.Tests/TopThink.ThinkAI.Tests.csproj --no-restore
dotnet format style dotnet/TopThink.ThinkAI/TopThink.ThinkAI.csproj --no-restore --diagnostics IDE0011 --severity info
dotnet format style dotnet/TopThink.ThinkAI.Tests/TopThink.ThinkAI.Tests.csproj --no-restore --diagnostics IDE0011 --severity info
```

给四条 format 命令追加 `--verify-no-changes` 即为 CI 使用的只读检查。样式诊断限定 IDE0011，仅用于保证控制语句的大括号。

## Go

使用 Go SDK 自带的标准格式工具：

```sh
gofmt -w go
gofmt -l go
```

CI 要求 `gofmt -l .` 输出为空。Go 不增加第三方格式依赖。

## 提交与产物

CI 在各语言任务中执行上述只读检查，格式不符会使任务失败。提交前先运行对应的修正命令，再检查 diff；格式检查不会修改源码或自动提交。根 `.gitattributes` 为已整理的源码扩展名固定 LF，避免 Windows 检出策略造成反复格式变化。

这些配置和开发工具不会加入 PHP dist；各语言安装包仍只包含各自运行所需的文件。格式整理不创建版本标签，也不发布包。发布仍使用[发布指南](PUBLISHING.md)中的手动脚本。
