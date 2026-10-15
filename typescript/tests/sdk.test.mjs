import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContractServer } from '../../tests/contracts/server.mjs';
import {
  Client,
  EventStream,
  BinaryStream,
  APIError,
  ProtocolError,
  OperationTimeout,
  TransportError,
  VERSION,
} from '../dist/esm/index.js';

const manifest = JSON.parse(
  readFileSync(new URL('../../tests/contracts/operations.json', import.meta.url)),
);
const fixture = createContractServer();
let endpoint;
before(async () => {
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${fixture.server.address().port}/`;
});
after(async () => {
  fixture.server.closeAllConnections();
  await new Promise((resolve) => fixture.server.close(resolve));
});

function args(operation) {
  const { resource, operation: name } = operation;
  if (resource === 'model' && name === 'show') return ['chat', 'fixture-model'];
  if (resource === 'skill' && name === 'categories') return [];
  if (resource === 'skill' && name === 'download') return ['skill.zip'];
  if (resource !== 'sandbox')
    return [{ model: 'fixture-model', unknown: { nested: [1, false, null] } }];
  return {
    create: ['test'],
    get: ['test'],
    delete: ['test'],
    listFile: ['test', '/tmp'],
    readFile: ['test', '/tmp/a'],
    writeFile: ['test', '/tmp/a', 'hello'],
    editFile: ['test', '/tmp/a', 'hello', 'world'],
    uploadFile: ['test', '/tmp/a', new Uint8Array([0, 1, 255])],
    downloadFile: ['test', '/tmp/a'],
    runCode: ['test', 'print(1)', [{ url: 'https://example.test/a', name: 'a.txt' }]],
    runCommand: ['test', 'pwd'],
  }[name];
}
async function consume(result) {
  if (result instanceof EventStream) {
    const events = [];
    for await (const event of result) events.push(event);
    return events;
  }
  if (result instanceof BinaryStream) return result.read();
  return result;
}

for (const operation of manifest) {
  test(`HTTP contract ${operation.resource}.${operation.operation}`, async () => {
    const client = new Client('offline-token', { endpoint: endpoint + 'prefix/' });
    await consume(await client[operation.resource][operation.operation](...args(operation)));
    const entry = fixture.requests.at(-1);
    const path = operation.path
      .replace('{id}', 'test')
      .replace('{type}', 'chat')
      .replace('{code}', 'fixture-model');
    assert.equal(entry.path, '/prefix/' + path);
    assert.equal(entry.method, operation.http_method);
    assert.equal(entry.authorization, 'Bearer offline-token');
    if (entry.body?.unknown) assert.deepEqual(entry.body.unknown, { nested: [1, false, null] });
    if (operation.operation === 'runCode')
      assert.deepEqual(entry.body.files, [{ url: 'https://example.test/a', name: 'a.txt' }]);
    if (operation.operation === 'uploadFile') {
      const multipart = Buffer.from(entry.raw_base64, 'base64');
      assert.match(entry.content_type, /^multipart\/form-data; boundary=/);
      assert.match(multipart.toString(), /name="path"/);
      assert.match(multipart.toString(), /name="file"; filename="a"/);
      assert.ok(multipart.includes(Buffer.from([0, 1, 255])));
    }
  });
}

test('injected fetch forwards raw fields, auth and does not retry HTTP errors', async () => {
  const calls = [];
  const client = new Client('test', {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ message: 'too many', details: 1 }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  await assert.rejects(
    client.chat.completions({ model: 'test', stream: false, x: null }),
    (error) =>
      error instanceof APIError &&
      error.statusCode === 429 &&
      JSON.parse(error.rawResponse).details === 1,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test');
  assert.equal(
    VERSION,
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version,
  );
  assert.equal(calls[0].init.headers['User-Agent'], `ThinkAI-TypeScript/${VERSION}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'test', stream: false, x: null });
});
test('GET query uses recursive PHP bracket encoding', async () => {
  const client = new Client('test', { endpoint });
  const result = await client.model.list({
    enabled: false,
    tags: ['a', 'b'],
    filter: { q: '你好' },
    skip: null,
  });
  assert.deepEqual(result.query, {
    enabled: '0',
    'tags[0]': 'a',
    'tags[1]': 'b',
    'filter[q]': '你好',
  });
});
test('JSON file download retains original bytes and returns binary stream', async () => {
  const client = new Client('test', { endpoint });
  const stream = await client.sandbox.downloadFile('test', 'fixture.json');
  assert.ok(stream instanceof BinaryStream);
  assert.equal(Buffer.from(await stream.read()).toString(), '{ "file": true }\n');
});

test('chat default and explicit stream false use actual Content-Type', async () => {
  const client = new Client('test', { endpoint });
  const stream = await client.chat.completions({ model: 'test' });
  assert.ok(stream instanceof EventStream);
  await stream.close();
  assert.equal(
    (await client.chat.completions({ model: 'test', stream: false })).body.stream,
    false,
  );
  assert.ok(
    (
      await consume(
        await client.audio.speech({ model: 'test', input: 'hello', voice: 'a', stream: true }),
      )
    ).length,
  );
  assert.ok((await consume(await client.sandbox.runCommand('test', 'pwd', true))).length);
});

for (const scenario of ['fragmented-sse', 'audio-sse', 'responses-error']) {
  test(`SSE ${scenario} preserves events`, async () => {
    const client = new Client('test', { endpoint });
    const events = await consume(
      await client.responses.create({ model: 'test', input: 'x', __case: scenario }),
    );
    assert.ok(events.length);
    if (scenario === 'responses-error') assert.ok(events.some((event) => event.chunks?.error));
  });
}
for (const scenario of ['invalid-json', 'invalid-sse']) {
  test(`rejects ${scenario}`, async () => {
    const client = new Client('test', { endpoint });
    await assert.rejects(
      async () =>
        consume(await client.responses.create({ model: 'test', input: 'x', __case: scenario })),
      ProtocolError,
    );
  });
}
test('disconnect closes stream and reports transport or incomplete protocol', async () => {
  const client = new Client('test', { endpoint });
  await assert.rejects(
    async () =>
      consume(await client.responses.create({ model: 'test', input: 'x', __case: 'disconnect' })),
    (error) => error instanceof ProtocolError || error instanceof TransportError,
  );
});
test('Avatar wait preserves task IDs and returns fail; query exceptions propagate', async () => {
  const client = new Client('test', { endpoint, pollInterval: 0.001 });
  assert.equal(
    (await client.avatar.video({ model: 'fixture:wait-success' }, true)).status,
    'success',
  );
  assert.equal((await client.avatar.video({ model: 'fixture:wait-fail' }, true)).status, 'fail');
  await assert.rejects(
    client.avatar.video({ model: 'fixture:wait-error' }, true),
    (error) => error instanceof APIError && error.statusCode === 403,
  );
  await assert.rejects(
    client.avatar.video({ model: 'fixture:wait-timeout' }, 0.02),
    OperationTimeout,
  );
});
test('total timeout and caller cancellation stop real HTTP requests', async () => {
  const client = new Client('test', { endpoint, timeout: 0.02 });
  await assert.rejects(
    async () => consume(await client.model.list({ __case: 'slow', __delay_ms: 100 })),
    OperationTimeout,
  );
  const controller = new AbortController();
  const pending = client.model.list(
    { __case: 'slow', __delay_ms: 100 },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});
test('timeout includes idle response stream lifetime and early close cancels body', async () => {
  let cancelled = false;
  const client = new Client('test', {
    timeout: 0.02,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  });
  const stream = await client.responses.create({ model: 'test' });
  await assert.rejects(consume(stream), OperationTimeout);
  assert.equal(cancelled, true);
});
test('SSE deadline also applies to events buffered in one network chunk', async () => {
  const client = new Client('test', {
    timeout: 0.02,
    fetch: async () =>
      new Response('data: {"first":true}\n\ndata: {"second":true}\n\ndata: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  });
  const stream = await client.responses.create({ model: 'test' });
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { first: true });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(iterator.next(), OperationTimeout);
});
test('package supports CommonJS', () => {
  const require = createRequire(import.meta.url);
  assert.equal(typeof require('../dist/cjs/index.js').Client, 'function');
});
