# Java SDK 发布到 Maven Central

坐标固定为 `com.topthink:think-ai`，Java 版本独立于 PHP、Python 和其他 SDK。更新 `java/pom.xml` 的项目版本，并使用 tag `java/v版本号`。正式操作使用仓库根的统一发布 CLI，它发布 build manifest 中已验收的精确产物字节；POM 另保留可独立使用的 Maven 发布 profile。

## 发布行为

统一 CLI 的 build 阶段完成测试与打包，记录主 JAR、sources JAR、javadoc JAR、POM 的 SHA256。publish 阶段校验这四个文件，将精确字节复制到同一 build 目录的 `central-UUID` 子目录后用 GPG 生成 detached signatures，打包成 Central bundle，直接调用官方 Portal API。publish 阶段不会再次运行 Maven 构建，原始四个文件不改变。

上传采用 `AUTOMATIC`，收到 deployment ID 后立即保存发布进度，再轮询到 PUBLISHED 才成功。验证失败 FAILED 立即停止；轮询默认 30 分钟、每 10 秒一次。已有 deployment ID 时仅需 Central token 即可恢复轮询，无需 GPG 私钥，不重新签名、打包或上传。上传连接中断且没有收到 ID 时，结果可能不确定，应先查看 Portal 状态。[官方 Portal API](https://central.sonatype.org/publish/publish-portal-api/)

`release` 是另一条显式启用的 Maven profile，没有自动激活条件。普通 `mvn -f java/pom.xml verify` 和 `install` 不会加载 GPG/Central 插件，不签名、不上传。

正式 profile 使用官方 `org.sonatype.central:central-publishing-maven-plugin:0.12.0`，server id 为 `central`，`autoPublish=true`、`waitUntil=published`。因此正式 deploy 会上传、验证并公开发布，命令成功表示 Central 确认 PUBLISHED；不会停留在需要网页再确认的 VALIDATED 状态。默认最多等待 1800 秒，发布超时不代表服务端发布被撤销，重试前应使用日志中的 deployment ID 核对 Portal 状态。[官方插件配置与状态说明](https://central.sonatype.org/publish/publish-portal-maven/)

版本 0.12.0 修复了 Maven 3.10.0 的 staging metadata 被误装入 bundle 的问题。使用 Maven 3.9.x 或 3.10.x、JDK 17+；官方当前注明 Maven 4 不受此发布插件支持。插件生成 MD5、SHA1、SHA256、SHA512 校验文件。[官方版本说明](https://central.sonatype.org/publish/publish-portal-maven/#release-notes)

## 首次准备账号与 namespace

1. 由发布者在 [Central Publisher Portal](https://central.sonatype.com/) 注册/登录账号。
2. 在账号的 namespace 管理中申请或取得 `com.topthink` 的发布权限。该 namespace 对应 `topthink.com`，需要在 **topthink.com 的 DNS TXT** 写入 Portal 提供的 Verification Key，再确认验证，直到显示 Verified。若 namespace 已由组织管理，使用有该 namespace 权限的账号；仅持有 GitHub `top-think` 仓库权限不能证明 `com.topthink` 权限。[namespace 验证](https://central.sonatype.org/register/namespace/)
3. 在 [User Tokens](https://central.sonatype.com/usertoken) 生成 Central **user token**，选择名称与有效期，安全保存生成的 username 和 password。这两项来自 token，不使用网站登录密码。[生成 token](https://central.sonatype.org/publish/generate-portal-token/)

账号、DNS 和 token 操作由发布者完成，不属于本地构建步骤。

## 凭据与独立 Maven settings

根 CLI 直接使用会话/CI secret 中的 `CENTRAL_TOKEN_USERNAME`、`CENTRAL_TOKEN_PASSWORD`，按 Portal 要求在内存中组成 `Bearer base64(username:password)`。不会将认证头写入 argv、文件或日志。下面的 settings 仅供独立 Maven profile 使用。

在用户自己的 `~/.m2/settings.xml`（Windows 通常是 `%USERPROFILE%\.m2\settings.xml`）配置 server。此文件不放入仓库；也可用 Maven `--settings` 指向仓库外的专用 settings 文件。

```xml
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0 https://maven.apache.org/xsd/settings-1.0.0.xsd">
  <servers>
    <server>
      <id>central</id>
      <username>${env.CENTRAL_TOKEN_USERNAME}</username>
      <password>${env.CENTRAL_TOKEN_PASSWORD}</password>
    </server>
  </servers>
</settings>
```

`CENTRAL_TOKEN_USERNAME` 与 `CENTRAL_TOKEN_PASSWORD` 从用户会话或 CI secret 注入。也可以使用 Maven 支持的用户 settings 密码加密机制。不要把 token 值、私钥、passphrase 或有效 settings 文件提交到仓库，也不要将 token 放进命令行参数或调试日志。[插件认证](https://central.sonatype.org/publish/publish-portal-maven/#credentials)

根 CLI 在实际发布前检查所需环境变量；独立 Maven 路径由 Central 插件读取并检查 `central` server。namespace 和 token 的服务端有效性只有 Central 实际验证时才能确认。

## GPG 首次准备

安装 [GnuPG](https://gnupg.org/download/) 并确保 `gpg --version` 可运行。用户自行创建或导入组织批准的签名私钥；密钥留在用户 keyring 或 CI secret 中，不放入仓库。

```sh
gpg --full-generate-key
gpg --list-secret-keys --keyid-format LONG
gpg --fingerprint YOUR_KEY_ID
gpg --keyserver keyserver.ubuntu.com --send-keys YOUR_PRIMARY_KEY_FINGERPRINT
```

选择可签名的主密钥，并使用其完整 fingerprint。主密钥公钥需要能被 Central 支持的 keyserver 获取；发送成功后，发布者应核对公钥是否可查询。Central 官方列出的 keyserver 包括 `keyserver.ubuntu.com` 和 `keys.openpgp.org`。[Central GPG 指南](https://central.sonatype.org/publish/requirements/gpg/)

根 CLI 使用 `GPG_KEY_ID` 选择用户 keyring 中的签名密钥，通过 GnuPG CLI 为已验收文件的副本生成 `.asc`；passphrase 仅经 stdin 传给 GPG，或使用已解锁 agent。将 `GPG_KEY_ID` 设为完整主密钥 fingerprint 加 `!` 可要求 GPG 使用指定主密钥，避免自动选择签名子密钥；该选择器不是秘密。

独立 Maven profile 使用 `maven-gpg-plugin:3.2.8`，在 `verify` 阶段为主 JAR、POM、sources 和 javadoc 附件生成 `.asc`，并启用 `bestPractices=true`。主密钥通过 `-Dgpg.keyname=完整fingerprint!` 指定，或者在用户 settings 的激活 profile 中设置 `gpg.keyname`。

两种路径的 passphrase 均使用已解锁的 `gpg-agent` 或环境变量 `MAVEN_GPG_PASSPHRASE`；批处理模式下 agent 不会弹出交互 pinentry，所以必须提前解锁，或者通过该环境变量提供。根 CLI 使用 `--passphrase-fd 0` 和 loopback pinentry，不把 passphrase 放入 argv/文件/日志。不要使用 `-Dgpg.passphrase=...` 或把 passphrase 写进 POM/settings。[GnuPG stdin 参数](https://www.gnupg.org/documentation/manuals/gnupg/GPG-Esoteric-Options.html)、[GPG 插件参数](https://maven.apache.org/plugins/maven-gpg-plugin/sign-mojo.html)

## 构建和正式命令

仅本地验收，不需要 Central token 或 GPG 私钥：

```sh
mvn -f java/pom.xml -B verify
python java/scripts/verify_package.py
```

统一 CLI 的入口：

```sh
node scripts/release.mjs build java
node scripts/release.mjs publish java
node scripts/release.mjs publish java --execute
```

publish 缺省预览，不签名/上传；`--execute` 会签名并公开发布已验收 bundle。发布会话需要 Node.js、Python 标准库、GnuPG、签名私钥、agent/passphrase、Central token 环境变量和 namespace 权限；build 还需要 JDK、Maven 及测试工具。bundle 的 Maven 路径为 `com/topthink/think-ai/版本/`，每个文件附 `.asc`、MD5、SHA1、SHA256、SHA512 校验，原始产物字节保持 manifest 所记录内容。

若发布者选择独立 Maven 路径，可使用以下命令；它会重新构建、签名和上传自己的构建结果。该路径不会使用根 CLI 的已验收产物 manifest，也不会写入根 CLI 发布进度：

```sh
mvn -f java/pom.xml -B -Prelease "-Dgpg.keyname=YOUR_PRIMARY_KEY_FINGERPRINT!" deploy
```

该 Maven deploy 命令会签名和公开发布。独立 Maven 路径需要 JDK 17+、Maven 3.9/3.10、Node.js（本地契约测试）、GnuPG、对应私钥、agent/passphrase、有效 Central settings token 及 `com.topthink` namespace 权限。需要自定义 settings 时在 Maven 命令中追加 `--settings /仓库外/settings.xml`。

上传内容包括主 JAR、sources JAR、javadoc JAR、POM、各自 `.asc` 和校验文件。主 JAR 保持 Apache LICENSE 与中文 README；发布配置不会合并其他语言 SDK。发布成功后用日志中的 deployment ID 和 Central Portal 核对版本；Maven Central 已发布版本不可覆盖，修复使用新版本。[产物要求](https://central.sonatype.org/publish/requirements/)、[版本不可变规则](https://central.sonatype.org/publish/requirements/immutability/)
