# ThinkAI TypeScript / JavaScript SDK

Node.js 22+，版本 1.0.1，包名 `@topthink/think-ai`。运行时使用原生 fetch，无第三方运行时依赖。提供 ESM、CommonJS 和 TypeScript 类型声明。遵循包内 [Apache-2.0 许可证](LICENSE)。

```bash
npm install @topthink/think-ai
```

上述命令在包发布后可用。开发时在本目录执行 `npm ci && npm run build`。SDK 覆盖 PHP SDK 的 14 个资源、37 个方法，资源使用属性，方法采用 camelCase。动态 JSON 参数原样发送，不在客户端过滤字段。

```ts
import { Client, EventStream } from '@topthink/think-ai';
const client = new Client('YOUR_TOKEN', { endpoint: 'https://ai.topthink.com/', timeout: 300 });
const result = await client.chat.completions({ model: 'YOUR_CHAT_MODEL', messages: [{ role: 'user', content: '你好' }] });
if (result instanceof EventStream) {
  try { for await (const event of result) console.log(event); }
  finally { await result.close(); }
} else console.log(result);

// Chat 默认 stream=true；显式 false 请求 JSON。仍按实际 Content-Type 判别响应。
await client.chat.completions({ model: 'YOUR_CHAT_MODEL', messages: [{ role: 'user', content: '你好' }], stream: false });
```

```js
const { Client } = require('@topthink/think-ai');
const client = new Client('YOUR_TOKEN');
```

Responses 始终请求 ThinkAI 的 SSE，原样交付 chunks/stats/id 等 JSON 事件；事件中的 error 和任务的 status=fail 不转为 HTTP 异常。`[DONE]` 仅结束迭代。Audio speech 的流是包含 base64 音频的 JSON 事件；SDK 不自动拼接音频。`EventStream` 支持异步迭代和 `close()`；下载为 `BinaryStream`，支持异步迭代、`read()` 和 `close()`。提前 break 或发生异常会关闭正在消费的流；取得流后未消费也需手动关闭。无响应体的成功请求返回 null。

下表覆盖全部方法；模型与地址为占位值，参数按对应模型和服务端实际要求填写。生成方法会产生内容和费用，不要批量运行这些示例。

| 资源 | 调用示例 |
|---|---|
| chat | `await client.chat.completions({model:'CHAT',messages:[],stream:false})` |
| responses | `await client.responses.create({model:'CHAT',input:'你好'})`，按上文消费/关闭事件流 |
| images | `await client.images.generations({model:'IMAGE',prompt:'山水'})` |
| images | `await client.images.inpainting({model:'IMAGE',image:'URL',mask:'MASK_URL',prompt:'树'})` |
| images | `await client.images.outpainting({model:'IMAGE',image:'URL',top:100})` |
| images | `await client.images.upscale({model:'IMAGE',image:'URL'})` |
| images | `await client.images.poster({model:'IMAGE',title:'海报'})` |
| images | `await client.images.edit({model:'IMAGE',image:'URL',prompt:'修改背景'})` |
| videos | `await client.videos.generations({model:'VIDEO',prompt:'海浪'})` |
| videos | `await client.videos.query({model:'VIDEO',id:'ORIGINAL_TASK_ID'})` |
| audio | `await client.audio.speech({model:'AUDIO',input:'你好',voice:'VOICE'})`；stream:true 请求流 |
| audio | `await client.audio.transcriptions({model:'ASR',url:'AUDIO_URL'})` |
| avatar | `await client.avatar.video({model:'AVATAR',anchor:'ANCHOR',text:'你好',voice:'VOICE'})` |
| avatar | `await client.avatar.query({model:'AVATAR',id:'ORIGINAL_TASK_ID'})` |
| music | `await client.music.song({model:'MUSIC',prompt:'春天'})` |
| music | `await client.music.bgm({model:'MUSIC',prompt:'轻松'})` |
| music | `await client.music.query({model:'MUSIC',id:'ORIGINAL_TASK_ID'})` |
| embeddings | `await client.embeddings.create({model:'EMBEDDING',input:'你好'})` |
| rerank | `await client.rerank.create({model:'RERANK',query:'问题',documents:['文档']})` |
| decision | `await client.decision.evaluate({model:'DECISION',state:{},questions:[]})` |
| plugin | `await client.plugin.list()` |
| model | `await client.model.list({type:'chat'})` |
| model | `await client.model.show('chat','MODEL_CODE')` |
| sandbox | `await client.sandbox.create('demo')` |
| sandbox | `await client.sandbox.get('SANDBOX_ID')` |
| sandbox | `await client.sandbox.delete('SANDBOX_ID')` |
| sandbox | `await client.sandbox.listFile('SANDBOX_ID','/tmp')` |
| sandbox | `await client.sandbox.readFile('SANDBOX_ID','/tmp/a.txt')` |
| sandbox | `await client.sandbox.writeFile('SANDBOX_ID','/tmp/a.txt','hello')` |
| sandbox | `await client.sandbox.editFile('SANDBOX_ID','/tmp/a.txt','hello','world')` |
| sandbox | `await client.sandbox.uploadFile('SANDBOX_ID','/tmp/a.txt','./a.txt')` |
| sandbox | `await client.sandbox.downloadFile('SANDBOX_ID','/tmp/a.txt')`，随后读取/关闭 BinaryStream |
| sandbox | `await client.sandbox.runCode('SANDBOX_ID','print(1)',[])` |
| sandbox | `await client.sandbox.runCommand('SANDBOX_ID','pwd')`，默认非流；第三参数 true 开启 SSE |
| skill | `await client.skill.list({category_id:1})` |
| skill | `await client.skill.categories()` |
| skill | `await client.skill.download('PATH_FROM_SKILL_LIST')`，随后读取/关闭 BinaryStream |

上传接受本地路径、Blob 或 Uint8Array，multipart 字段固定 path/file。原始 JSON 不作资源字段重命名。类型为 `Result = Json | EventStream | BinaryStream`，使用 `instanceof` 区分流后再按业务需要缩小 JSON 类型。

导出 `ChatParams`、`ChatMessage`、`ResponsesParams`、`AudioSpeechParams` 提供常用参数提示；字段均可选，继承 `Params` 保留任意扩展字段，不增加运行时验证。例如 `import type { ChatParams } from '@topthink/think-ai'` 后可声明 `const params: ChatParams = { model: 'CHAT', messages: [], custom_option: true }`。

Avatar 第二参数默认 false；true 等待最多 300 秒；正数指定秒数。每 5 秒查询原始任务 ID，通过 `pollInterval` 可配置间隔。processing 继续轮询，success/fail 返回原结果，查询异常立即抛出。

默认 TLS 校验开启，不自动重试；`timeout` 单位秒，总时限 300 秒，包含流读取。所有资源方法最后一个参数接受 `{signal,timeout}`；Avatar 为第三参数。取消会中断请求、流或轮询等待，不重新提交生成。

```ts
const controller = new AbortController();
const result = await client.responses.create({model:'CHAT',input:'你好'}, {signal:controller.signal, timeout:60});
controller.abort(); // 取消未完成的请求/流。
```

HTTP 失败抛 `APIError`，保留 statusCode/rawResponse；网络失败为 `TransportError`，超时为 `OperationTimeout`，无效 JSON 或不完整 SSE 为 `ProtocolError`；调用方取消保留 AbortSignal.reason。可注入 `new Client(token, {fetch: customFetch})`，测试 fetch 应遵循传入的 AbortSignal。

```bash
# 只使用注入 fetch 和共享 localhost 服务，不请求真实 ThinkAI。
npm ci
npm test
npm pack --dry-run
npm run check:package
```
