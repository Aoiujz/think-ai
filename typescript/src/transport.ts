/** Copyright TOPThink. Licensed under Apache-2.0. */
import { VERSION } from './version.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Params = Record<string, unknown>;
export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}
export class APIError extends Error {
  // prettier-ignore
  constructor(message: string, public readonly statusCode: number, public readonly rawResponse: string) {
    super(message);
    this.name = 'APIError';
  }
}
export class TransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransportError';
  }
}
export class OperationTimeout extends TransportError {
  constructor() {
    super('ThinkAI operation timed out');
    this.name = 'OperationTimeout';
  }
}
export class ProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProtocolError';
  }
}
const DONE = Symbol('SSE terminator');

export class BinaryStream implements AsyncIterable<Uint8Array>, AsyncDisposable {
  protected reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private closed = false;
  private used = false;
  // prettier-ignore
  constructor(public readonly response: Response, protected readonly signal: AbortSignal, private readonly cleanup: () => void) {
    signal.addEventListener('abort', this.onAbort, { once: true });
  }
  private onAbort = () => {
    void this.reader?.cancel()
      .catch(() => {});
  };
  protected check(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.used) throw new ProtocolError('Response streams can only be consumed once');
    this.used = true;
    try {
      this.check();
      if (!this.response.body) return;
      this.reader = this.response.body.getReader();
      while (true) {
        this.check();
        const { value, done } = await this.reader.read();
        this.check();
        if (done) return;
        yield value;
      }
    } catch (error) {
      this.check();
      if (error instanceof ProtocolError) throw error;
      throw new TransportError('Failed to read response stream', { cause: error });
    } finally {
      await this.close();
    }
  }
  async read(): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of this) {
      chunks.push(chunk);
      size += chunk.length;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    this.cleanup();
    try {
      if (this.reader) {
        await this.reader.cancel();
      } else {
        await this.response.body?.cancel();
      }
    } finally {
      this.reader?.releaseLock();
    }
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export class EventStream implements AsyncIterable<Json>, AsyncDisposable {
  // prettier-ignore
  constructor(private readonly binary: BinaryStream, private readonly signal: AbortSignal) {}
  async *[Symbol.asyncIterator](): AsyncIterator<Json> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let data: string[] = [];
    const decode = (): Json | typeof DONE => {
      const text = data.join('\n');
      data = [];
      if (text === '[DONE]') return DONE;
      try {
        return JSON.parse(text) as Json;
      } catch (error) {
        throw new ProtocolError('Invalid JSON in SSE event', { cause: error });
      }
    };
    try {
      for await (const bytes of this.binary) {
        buffer += decoder.decode(bytes, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          if (this.signal.aborted) throw this.signal.reason;
          const line = buffer.slice(0, index)
            .replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line === '' && data.length) {
            const event = decode();
            if (event === DONE) return;
            yield event;
          } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      buffer += decoder.decode();
      if (this.signal.aborted) throw this.signal.reason;
      if (buffer.startsWith('data:')) {
        data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
      }
      if (data.length) {
        const event = decode();
        if (event === DONE) return;
        yield event;
      }
      throw new ProtocolError('SSE stream ended before [DONE]');
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ProtocolError('Invalid UTF-8 in SSE stream', { cause: error });
      }
      throw error;
    } finally {
      await this.close();
    }
  }
  async close(): Promise<void> {
    await this.binary.close();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export type Result = Json | EventStream | BinaryStream;

export interface TransportOptions {
  endpoint: string;
  token: string;
  timeout: number;
  fetch: typeof globalThis.fetch;
}
function queryPairs(params: Params): [string, string][] {
  const result: [string, string][] = [];
  const append = (key: string, value: unknown): void => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => append(`${key}[${index}]`, item));
    } else if (typeof value === 'object') {
      for (const [child, item] of Object.entries(value)) append(`${key}[${child}]`, item);
    } else {
      result.push([key, value === true ? '1' : value === false ? '0' : String(value)]);
    }
  };
  for (const [key, value] of Object.entries(params)) append(key, value);
  return result;
}
export async function request(config: TransportOptions, method: string, path: string, params: Params | undefined, options: RequestOptions = {}, multipart?: FormData, forceBinary = false): Promise<Result> {
  const timeout = options.timeout ?? config.timeout;
  if (!(timeout > 0)) throw new RangeError('timeout must be positive');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new OperationTimeout()), timeout * 1000);
  timer.unref?.();
  const onAbort = () => controller.abort(options.signal?.reason ?? new DOMException('Operation cancelled', 'AbortError'));
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  };
  let response: Response | undefined;
  let retained = false;
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  try {
    check();
    const url = new URL(path, config.endpoint.endsWith('/') ? config.endpoint : config.endpoint + '/');
    if (method === 'GET' && params) {
      for (const [key, value] of queryPairs(params)) url.searchParams.append(key, value);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`,
      'User-Agent': `ThinkAI-TypeScript/${VERSION}`,
      Accept: 'application/json',
    };
    if (params && method !== 'GET') headers['Content-Type'] = 'application/json';
    response = await config.fetch(url, {
      method,
      headers,
      signal: controller.signal,
      body: multipart ?? (params && method !== 'GET' ? JSON.stringify(params) : undefined),
    });
    check();
    if (!response.ok) {
      const body = await response.text();
      check();
      let message = body || `HTTP ${response.status}`;
      try {
        const value = JSON.parse(body);
        message = String(value.message ?? value.error ?? message);
      } catch {}
      throw new APIError(message, response.status, body);
    }
    if (forceBinary) {
      retained = true;
      return new BinaryStream(response, controller.signal, cleanup);
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      retained = true;
      return new EventStream(new BinaryStream(response, controller.signal, cleanup), controller.signal);
    }
    if (contentType.includes('application/json') || contentType.includes('+json')) {
      const body = await response.text();
      check();
      if (!body) return null;
      try {
        return JSON.parse(body) as Json;
      } catch (error) {
        throw new ProtocolError('Invalid JSON response', { cause: error });
      }
    }
    if (response.status === 204 || response.status === 205 || response.headers.get('content-length') === '0') {
      return null;
    }
    retained = true;
    return new BinaryStream(response, controller.signal, cleanup);
  } catch (error) {
    check();
    if (error instanceof APIError || error instanceof ProtocolError) throw error;
    throw new TransportError('ThinkAI request failed', { cause: error });
  } finally {
    if (!retained) {
      cleanup();
      await response?.body?.cancel()
        .catch(() => {});
    }
  }
}
