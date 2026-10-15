/** Resource grouping matches the PHP SDK. JSON fields are forwarded unchanged. */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  request,
  OperationTimeout,
  ProtocolError,
  type Params,
  type RequestOptions,
  type Result,
  type Json,
  type TransportOptions,
} from './transport.js';
export * from './transport.js';
export { VERSION } from './version.js';

/** Common request fields are optional hints; extension fields remain available. */
export interface ChatMessage extends Params {
  role?: string;
  content?: unknown;
}
export interface ChatParams extends Params {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  tools?: Params[];
  max_tokens?: number;
  temperature?: number;
  thinking?: string;
  response_format?: unknown;
}
export interface ResponsesParams extends Params {
  model?: string;
  input?: unknown;
  instructions?: string;
  previous_id?: string;
  tools?: unknown;
}
export interface AudioSpeechParams extends Params {
  model?: string;
  input?: string;
  voice?: unknown;
  stream?: boolean;
  speed?: number;
  format?: string;
  sample_rate?: number;
  response_format?: string;
}

export interface ClientOptions {
  endpoint?: string;
  /** Total operation timeout in seconds, including reading a stream. */
  timeout?: number;
  /** Avatar polling interval in seconds. */
  pollInterval?: number;
  fetch?: typeof globalThis.fetch;
}
class Resource {
  constructor(protected readonly client: Client) {}
  protected call(
    method: string,
    path: string,
    params?: Params,
    options?: RequestOptions,
    binary = false,
  ): Promise<Result> {
    return this.client.request(method, path, params, options, undefined, binary);
  }
}

export class Chat extends Resource {
  completions(params: ChatParams, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'chat/completions', { stream: true, ...params }, options);
  }
}

export class Responses extends Resource {
  create(params: ResponsesParams, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'responses', params, options);
  }
}

export class Images extends Resource {
  generations(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'images/generations', params, options);
  }
  inpainting(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'images/inpainting', params, options);
  }
  outpainting(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'images/outpainting', params, options);
  }
  upscale(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'images/upscale', params, options);
  }
  poster(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'images/poster', params, options);
  }
  edit(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'images/edit', params, options);
  }
}

export class Videos extends Resource {
  generations(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'videos/generations', params, options);
  }
  query(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'videos/query', params, options);
  }
}

export class Audio extends Resource {
  speech(params: AudioSpeechParams, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'audio/speech', params, options);
  }
  transcriptions(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'audio/transcriptions', params, options);
  }
}

export class Avatar extends Resource {
  query(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'avatar/query', params, options);
  }
  async video(
    params: Params,
    wait: boolean | number = false,
    options: RequestOptions = {},
  ): Promise<Result> {
    const seconds = wait === true ? 300 : wait === false ? 0 : wait;
    if (!Number.isFinite(seconds) || seconds < 0)
      throw new RangeError('wait must be false, true or non-negative seconds');
    let result = await this.call('POST', 'avatar/video', params, options);
    if (!seconds) return result;
    if (!result || typeof result !== 'object' || !('id' in result) || !result.id)
      throw new ProtocolError('Avatar generation did not return a task ID');
    const id = result.id;
    const deadline = performance.now() + seconds * 1000;
    while (true) {
      const remaining = (deadline - performance.now()) / 1000;
      if (remaining <= 0) throw new OperationTimeout();
      result = await this.call(
        'POST',
        'avatar/query',
        { model: params.model, id },
        { ...options, timeout: Math.min(options.timeout ?? this.client.timeout, remaining) },
      );
      const status =
        result && typeof result === 'object' && 'status' in result ? result.status : undefined;
      if (status === 'success' || status === 'fail') return result;
      if (status !== 'processing') throw new ProtocolError('Unknown Avatar task status');
      const sleep = Math.min(this.client.pollInterval * 1000, deadline - performance.now());
      if (sleep <= 0) throw new OperationTimeout();
      await delay(sleep, undefined, { signal: options.signal });
    }
  }
}

export class Music extends Resource {
  song(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'music/song', params, options);
  }
  bgm(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'music/bgm', params, options);
  }
  query(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'music/query', params, options);
  }
}

export class Embeddings extends Resource {
  create(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'embeddings', params, options);
  }
}

export class Rerank extends Resource {
  create(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'rerank', params, options);
  }
}

export class Decision extends Resource {
  evaluate(params: Params, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'decisions', params, options);
  }
}

export class Plugin extends Resource {
  list(params: Params = {}, options?: RequestOptions): Promise<Result> {
    return this.call('GET', 'plugin', params, options);
  }
}

export class Model extends Resource {
  list(params: Params = {}, options?: RequestOptions): Promise<Result> {
    return this.call('GET', 'model', params, options);
  }
  show(type: string, code: string, options?: RequestOptions): Promise<Result> {
    return this.call(
      'GET',
      `model/${encodeURIComponent(type)}/${encodeURIComponent(code)}`,
      undefined,
      options,
    );
  }
}

export class Skill extends Resource {
  list(params: Params = {}, options?: RequestOptions): Promise<Result> {
    return this.call('GET', 'skill', params, options);
  }
  categories(options?: RequestOptions): Promise<Result> {
    return this.call('GET', 'skill/category', undefined, options);
  }
  download(path: string, options?: RequestOptions): Promise<Result> {
    return this.call('GET', 'skill/download', { path }, options, true);
  }
}

export class Sandbox extends Resource {
  create(name: string | null = null, options?: RequestOptions): Promise<Result> {
    return this.call('POST', 'sandbox', { name }, options);
  }
  get(id: string, options?: RequestOptions): Promise<Result> {
    return this.call('GET', `sandbox/${encodeURIComponent(id)}`, undefined, options);
  }
  delete(id: string, options?: RequestOptions): Promise<Result> {
    return this.call('DELETE', `sandbox/${encodeURIComponent(id)}`, undefined, options);
  }
  listFile(id: string, path: string | null = null, options?: RequestOptions): Promise<Result> {
    return this.call('GET', `sandbox/${encodeURIComponent(id)}/list`, { path }, options);
  }
  readFile(id: string, path: string, options?: RequestOptions): Promise<Result> {
    return this.call('GET', `sandbox/${encodeURIComponent(id)}/read`, { path }, options);
  }
  writeFile(id: string, path: string, content: string, options?: RequestOptions): Promise<Result> {
    return this.call('POST', `sandbox/${encodeURIComponent(id)}/write`, { path, content }, options);
  }
  editFile(
    id: string,
    path: string,
    oldStr: string,
    newStr = '',
    options?: RequestOptions,
  ): Promise<Result> {
    return this.call(
      'POST',
      `sandbox/${encodeURIComponent(id)}/edit`,
      { path, old_str: oldStr, new_str: newStr },
      options,
    );
  }
  downloadFile(id: string, path: string, options?: RequestOptions): Promise<Result> {
    return this.call('GET', `sandbox/${encodeURIComponent(id)}/download`, { path }, options, true);
  }
  runCode(
    id: string,
    code: string,
    files: Params[] = [],
    options?: RequestOptions,
  ): Promise<Result> {
    return this.call('POST', `sandbox/${encodeURIComponent(id)}/code`, { code, files }, options);
  }
  runCommand(
    id: string,
    command: string,
    stream = false,
    options?: RequestOptions,
  ): Promise<Result> {
    return this.call(
      'POST',
      `sandbox/${encodeURIComponent(id)}/command`,
      { command, stream },
      options,
    );
  }
  async uploadFile(
    id: string,
    path: string,
    file: string | Blob | Uint8Array,
    options?: RequestOptions,
  ): Promise<Result> {
    const content = typeof file === 'string' ? await readFile(file) : file;
    const form = new FormData();
    form.set('path', path);
    form.set(
      'file',
      content instanceof Blob ? content : new Blob([new Uint8Array(content).buffer]),
      basename(path),
    );
    return this.client.request(
      'POST',
      `sandbox/${encodeURIComponent(id)}/upload`,
      undefined,
      options,
      form,
    );
  }
}

export class Client {
  readonly timeout: number;
  readonly pollInterval: number;
  private readonly config: TransportOptions;
  readonly chat: Chat;
  readonly responses: Responses;
  readonly images: Images;
  readonly videos: Videos;
  readonly audio: Audio;
  readonly avatar: Avatar;
  readonly music: Music;
  readonly embeddings: Embeddings;
  readonly rerank: Rerank;
  readonly decision: Decision;
  readonly plugin: Plugin;
  readonly model: Model;
  readonly skill: Skill;
  readonly sandbox: Sandbox;
  constructor(token: string, options: ClientOptions = {}) {
    this.timeout = options.timeout ?? 300;
    this.pollInterval = options.pollInterval ?? 5;
    if (!(this.timeout > 0) || this.pollInterval < 0)
      throw new RangeError('timeout must be positive and pollInterval non-negative');
    this.config = {
      token,
      endpoint: options.endpoint ?? 'https://ai.topthink.com/',
      timeout: this.timeout,
      fetch: options.fetch ?? globalThis.fetch,
    };
    this.chat = new Chat(this);
    this.responses = new Responses(this);
    this.images = new Images(this);
    this.videos = new Videos(this);
    this.audio = new Audio(this);
    this.avatar = new Avatar(this);
    this.music = new Music(this);
    this.embeddings = new Embeddings(this);
    this.rerank = new Rerank(this);
    this.decision = new Decision(this);
    this.plugin = new Plugin(this);
    this.model = new Model(this);
    this.skill = new Skill(this);
    this.sandbox = new Sandbox(this);
  }
  request(
    method: string,
    path: string,
    params?: Params,
    options?: RequestOptions,
    multipart?: FormData,
    binary = false,
  ): Promise<Result> {
    return request(this.config, method, path, params, options, multipart, binary);
  }
}
