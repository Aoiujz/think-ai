## ThinkAI 多语言 SDK

ThinkAI 官方 SDK，提供 PHP、Python、TypeScript/JavaScript、Go、Java、C# 六种语言入口。新增 SDK 目前提供本地构建与安装方式，公开包注册和发布是独立步骤。

| 语言 | 运行时 | 文档 | 包标识 |
| --- | --- | --- | --- |
| PHP | 8.0+ | [PHP 用法](php/README.md) | `topthink/think-ai` |
| Python | 3.11+ | [Python 用法](python/README.md) | `topthink-think-ai`，导入 `thinkai` |
| TypeScript / JavaScript | Node.js 22+ | [Node.js 用法](typescript/README.md) | `@topthink/think-ai` |
| Go | 1.26+ | [Go 用法](go/README.md) | `github.com/top-think/think-ai/go` |
| Java | 17+ | [Java 用法](java/README.md) | `com.topthink:think-ai` |
| C# | .NET 10 | [.NET 用法](dotnet/README.md) | `TopThink.ThinkAI` |

六种 SDK 对齐 Chat、Responses、Images、Videos、Audio、Avatar、Music、Embeddings、Rerank、Decision、Plugin、Model、Sandbox、Skill，共 14 类资源、37 个方法。参数使用字典/JSON，字段和返回结果保持服务端原始格式，资源方法遵循各语言习惯。

Chat 保留 PHP 的默认流式语义，使用 `stream=false` 请求 JSON；Responses 使用 ThinkAI 自有事件格式。各语言文档提供流式消费、关闭、文件传输、任务查询及错误处理示例。

### PHP 安装保持不变

```sh
composer require topthink/think-ai
```

PHP 源码迁到 `php/src/`，命名空间和公开用法保持不变。根 `.gitattributes` 排除其他语言目录，Composer **dist** 安装只包含 PHP SDK 及必要元数据；`--prefer-source` 会克隆完整仓库。[Composer 分发包说明](https://getcomposer.org/doc/02-libraries.md#light-weight-distribution-packages)

### 开发与验收

每种 SDK 的 README 包含本地安装、测试、构建和资源示例。公共接口矩阵见 [SDK 协议](docs/SDK_CONTRACT.md)，本地 HTTP 样例见 [共用契约测试](tests/contracts/README.md)，实际检查结果见 [验收记录](docs/VALIDATION.md)。

```sh
composer install
php tests/php/compatibility.php
python tests/php/verify-migration.py
python tests/packaging/php-dist.py
node tests/contracts/server.mjs
```

测试请求仅发送至 Mock 或本地回环服务；离线结果不代表真实模型、计费或公开发布已验证。六种 SDK 当前版本统一为 1.0.1，分别构建并支持手动显式发布；PHP/Go 分别使用 `v*`、`go/v*` 版本标签。

CI 为需要 Python 的任务显式安装 Python，并按分支或 PR 对并发运行分组，取消同组旧运行。验证通过的 PHP ZIP、Python wheel/sdist、npm tarball、Java JAR/POM 和 NuGet 包可在 Actions 运行页的 Artifacts 中下载，保留 14 天；Go 验证源码模块，不生成上传包。每个 artifact 仅含当前版本产物和校验清单。CI 只执行测试与构建，不发布 SDK，也不创建或推送版本标签；标签 push 不触发此工作流。

项目使用 [Apache-2.0](LICENSE) 许可证。

### 代码格式

新 SDK 的源码与测试使用语言原生或常用格式工具：Java 使用 Spotless / Eclipse JDT，Python 使用 Ruff，TypeScript / JavaScript 使用 Prettier 与 ESLint Stylistic，C# 使用 dotnet format，Go 使用 gofmt。Java、Python、C# 采用 4 空格缩进，普通函数定义和调用的参数列表保持单行，独立的链式调用每个方法单独一行；控制流及非空方法体展开，参数中的对象、回调等代码块保留内部结构。参数内部嵌套的链保留单行，以保持外层普通参数不拆分。

根 `.editorconfig` 提供编辑器默认配置；工具版本、修正命令和 CI 检查范围见 [代码格式指南](docs/FORMATTING.md)。格式工具为开发依赖，CI 仅检查格式。

### 版本发布

使用统一的跨平台脚本管理各 SDK 的独立版本，完整账号准备和命令见 [发布指南](docs/PUBLISHING.md)。

```sh
node scripts/release.mjs status
node scripts/release.mjs prepare python 1.0.2
node scripts/release.mjs prepare python 1.0.2 --execute
# 提交并推送版本变更后
node scripts/release.mjs build python
node scripts/release.mjs publish python
node scripts/release.mjs publish python --execute
```

六种 SDK 的 prepare/publish 缺省预演；只有显式 --execute 才正式发布。PHP/Go 正式发布推送各自精确版本标签并查询平台索引；Python、TypeScript、Java、C# 推送各自标签并上传对应平台，凭据留在用户环境中。PHP/Go 索引尚未可见时记录 index-pending，可重试或只读 verify；CI 不执行这些发布操作。

---

## ThinkAI 服务与 PHP 快速示例

[ThinkAI](https://doc.topthink.com/think-ai/default.html)致力于为企业和开发者提供便捷高效的大模型对话、图像、语音、视频、向量等AI接口聚合服务。通过ThinkAI，用户可以一站式轻松地调用各类LLM模型和AI能力，将其整合到自己的产品和服务中，实现更加智能化的功能，助力企业数智化转型。

## 支持模型
目前顶想ThinkAI已经支持了包括GPT、DeepSeek、智谱、火山智能、星火、通义千问、腾讯混元、字节豆包、MiniMax、月之暗面在内的多个模型，未来还将不断添加更多类型的模型支持。开发者可以加入官方的[推广奖励计划](https://doc.topthink.com/public/cooperation.html)（最高返利15%）。

ThinkAI更注重提供底层的AI接口服务，这意味着用户可以更加灵活地自主研发AI应用服务。如果没有研发能力或者希望快速搭建应用，可以使用官方的ThinkBot启智AI Agent服务，为企业提供了更加便捷的开箱即用的解决方案（[体验启智](https://bot.topthink.com) ）。个人用户可以直接使用我们的AI助理服务ThinkChat（支持聊天、画画、视频、搜索、阅读和智能体市场，[立刻体验](https://chat.topthink.com)）。

## 安装
```
composer require topthink/think-ai
```

生成[Token令牌](https://console.topthink.com/user/token)，并注意需要勾选启智AI。

## 用法
### 聊天
```php
use think\ai\Client;

$client = new Client('YOUR_TOKEN');

//非流式输出
$result = $client->chat()->completions([
    'model' => 'gpt-3.5-turbo',
    'messages' => [
        ['role' => 'user', 'content' => 'Hello!'],
    ],
    'stream'=>false,
]);
dump($result);

//流式输出
$result = $client->chat()->completions([
    'model' => 'gpt-3.5-turbo',
    'messages' => [
        ['role' => 'user', 'content' => 'Hello!'],
    ],
    'stream'=>true,
]);
foreach($result as $chunk){
    dump($chunk);
}
```

### 图像
```php
use think\ai\Client;

$client = new Client('YOUR_TOKEN');

//画图
$client->images()->generations($params);
//涂抹编辑
$client->images()->inpainting($params);
//图像扩展
$client->images()->outpainting($params);
```

### 决策
```php
use think\ai\Client;

$client = new Client('YOUR_TOKEN');

$result = $client->decision()->evaluate([
    'model' => 'jev-latest',
    'state' => 'Help! My payouts have been failing for 3 days.',
    'questions' => [
        'is_urgent' => [
            'type' => 'noul',
            'instructions' => 'Does this convey urgency?',
        ],
        'department' => [
            'type' => 'choice',
            'instructions' => 'Which team should handle this?',
            'criteria' => [
                'billing'   => 'Payments, invoicing, refunds',
                'technical' => 'Bugs, outages, integrations',
            ],
        ],
    ],
]);

// $result['answers']['is_urgent']['noul'] => 0.95
// $result['answers']['department']['choice'] => 'billing'
```

...其他用法类似
