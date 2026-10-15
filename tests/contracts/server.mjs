import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const operations = JSON.parse(readFileSync(new URL('./operations.json', import.meta.url)));
const routes = operations.map((operation) => ({
  ...operation,
  pattern: new RegExp('^/' + operation.path.replace(/\{[^}]+\}/g, '[^/]+') + '$'),
}));

export function createContractServer() {
  const requests = [];
  const tasks = new Map();
  let nextTask = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = null;
    try {
      body =
        raw.length && request.headers['content-type']?.includes('application/json')
          ? JSON.parse(raw.toString('utf8'))
          : null;
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ message: 'Invalid request JSON' }));
    }
    const json = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/__health') return json({ ok: true });
    if (url.pathname === '/__requests') return json(requests);
    if (url.pathname === '/__reset') {
      requests.length = 0;
      tasks.clear();
      return json({ ok: true });
    }
    const pathname = url.pathname.replace(/^\/prefix(?=\/)/, '');
    const route = routes.find(
      (item) => item.http_method === request.method && item.pattern.test(pathname),
    );
    if (!route) return json({ message: 'Unknown contract route' }, 404);
    const entry = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: request.headers.authorization,
      content_type: request.headers['content-type'],
      raw_base64: raw.toString('base64'),
    };
    requests.push(entry);
    if (!request.headers.authorization?.startsWith('Bearer '))
      return json({ message: 'Unauthorized' }, 401);
    const testCase =
      body?.__case ??
      url.searchParams.get('__case') ??
      (body?.model?.startsWith('fixture:') ? body.model.slice(8) : null);
    if (testCase === 'error' || testCase === 'http-error')
      return json(
        { message: 'Offline fixture error', details: { field: 'model' } },
        Number(body?.__status ?? url.searchParams.get('__status') ?? 400),
      );
    if (testCase === 'invalid-json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end('{invalid');
    }
    if (pathname === '/avatar/video' && testCase?.startsWith('wait-')) {
      const id = 'offline-task-' + ++nextTask;
      tasks.set(id, { testCase, queries: 0, model: body.model });
      return json({ id, status: 'processing' });
    }
    if (pathname === '/avatar/query' && tasks.has(body?.id)) {
      const task = tasks.get(body.id);
      if (body.model !== task.model) return json({ message: 'Polling model changed' }, 400);
      task.queries++;
      if (task.testCase === 'wait-error') return json({ message: 'Query failed' }, 403);
      if (task.testCase === 'wait-timeout' || task.queries === 1)
        return json({ id: body.id, status: 'processing' });
      return json({
        id: body.id,
        status: task.testCase === 'wait-fail' ? 'fail' : 'success',
        video: 'offline://video',
      });
    }
    if (testCase === 'empty' || route.response === 'empty') {
      response.writeHead(204);
      return response.end();
    }
    if (testCase === 'binary' || route.response === 'binary') {
      if (url.searchParams.get('path') === 'fixture.json') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end('{ "file": true }\n');
      }
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="fixture.bin"',
      });
      return response.end(Buffer.from([0, 1, 2, 255, 10, 13, 80, 75]));
    }
    const streaming =
      route.response === 'sse' ||
      testCase?.includes('sse') ||
      testCase === 'responses-error' ||
      testCase === 'slow' ||
      testCase === 'disconnect' ||
      (pathname === '/chat/completions' && body?.stream !== false && testCase !== 'json') ||
      (pathname === '/audio/speech' && body?.stream === true) ||
      (pathname.endsWith('/command') && body?.stream === true);
    if (!streaming) return json(entry);
    const events =
      pathname === '/responses'
        ? [
            { chunks: { index: 0, content: '你好🌍' } },
            ...(testCase === 'responses-error'
              ? [{ chunks: { index: 0, error: 'Offline event error' } }]
              : []),
            { stats: { usage: 2, latency: 1 } },
            { id: 'offline-response' },
          ]
        : testCase === 'audio-sse' || pathname === '/audio/speech'
          ? [
              { audio: { type: 'audio/x-wav', data: 'AAEC' } },
              { audio: { type: 'audio/x-wav', data: '/w==' } },
              { sentences: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } },
            ]
          : [
              { delta: { content: '你好🌍' } },
              {
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                finish_reason: 'stop',
              },
            ];
    const payload =
      testCase === 'invalid-sse'
        ? 'data: {broken}\n\n'
        : ': heartbeat\r\nevent: message\r\n' +
          events
            .map((event, index) => {
              const value = JSON.stringify(event);
              // A whitespace boundary inside a JSON object makes a valid multiline data event.
              return (
                'data: ' +
                (index === 0 ? value.slice(0, 1) + '\r\ndata: ' + value.slice(1) : value) +
                '\r\n\r\n'
              );
            })
            .join('') +
          'data: [DONE]\r\n\r\n';
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    if (testCase === 'slow') {
      response.flushHeaders();
      const timer = setTimeout(() => response.end(payload), Number(body?.__delay_ms ?? 1000));
      response.once('close', () => clearTimeout(timer));
      return;
    }
    if (testCase === 'disconnect') {
      response.write('data: {"partial":');
      const timer = setTimeout(() => response.destroy(), 10);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    if (testCase === 'fragmented-sse') {
      const bytes = Buffer.from(payload);
      let offset = 0;
      const send = () => {
        if (response.destroyed) return;
        if (offset >= bytes.length) return response.end();
        response.write(bytes.subarray(offset, ++offset));
        timer = setTimeout(send, 1);
      };
      let timer = setTimeout(send, 0);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    response.end(payload);
  });
  return { server, requests, tasks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createContractServer();
  server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
    console.log(JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}/` }));
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
