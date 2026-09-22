import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readConfig, GatewayConfig } from './config.js';
import { GatewayError } from './errors.js';
import { parseAsk, simplifyAnswer } from './ask.js';
import { abortable, createUpstream, UpstreamCall } from './upstream.js';

const hash = (value: string) => createHash('sha256').update(value).digest();

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function readBody(request: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => { cleanup(); request.resume(); reject(error); };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new GatewayError(413, 'request_too_large', 'Request body exceeds the size limit.'));
      } else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = () => fail(new GatewayError(400, 'invalid_request', 'Request body was interrupted.'));
    const onAbort = () => fail(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RequestLog {
  event: 'jev_request';
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export class JevGateway {
  private inFlight = 0;

  constructor(
    private config: () => GatewayConfig = readConfig,
    private upstream: UpstreamCall = createUpstream(),
    private log: (entry: RequestLog) => void = entry => console.info(JSON.stringify(entry)),
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    // 只接受 origin-form URL，路径和查询参数不能改变上游 host。
    const url = request.url || '/';
    const path = url.split('?')[0];
    const method = request.method || 'GET';
    const isHealth = ['/healthz', '/readyz', '/home'].includes(path);
    let acquired = false;
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const disconnected = () => {
      if (!response.writableEnded) controller.abort(new GatewayError(499, 'client_closed_request', 'Client disconnected.'));
    };
    request.once('aborted', disconnected);
    response.once('close', disconnected);
    try {
      if (isHealth && method === 'GET') {
        if (path === '/readyz') this.config();
        json(response, 200, { status: 'ok' });
        return;
      }
      const expectedMethod = path === '/v1/models' ? 'GET' : ['/v1/systemone', '/ask'].includes(path) ? 'POST' : undefined;
      if (!expectedMethod) throw new GatewayError(404, 'not_found', 'Unknown endpoint.');
      if (method !== expectedMethod) {
        response.setHeader('allow', expectedMethod);
        throw new GatewayError(405, 'method_not_allowed', 'Unsupported HTTP method.');
      }
      const config = this.config();
      const authorization = request.headers.authorization;
      const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
      if (!match || !timingSafeEqual(hash(match[1]), hash(config.token))) {
        response.setHeader('www-authenticate', 'Bearer');
        throw new GatewayError(401, 'unauthorized', 'A valid gateway token is required.');
      }
      if (this.inFlight >= config.maxConcurrency) {
        response.setHeader('retry-after', '1');
        throw new GatewayError(429, 'concurrency_limit', 'Too many requests in progress.');
      }
      this.inFlight++;
      acquired = true;
      let body: Buffer | undefined;
      let ask: ReturnType<typeof parseAsk> | undefined;
      if (method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
          throw new GatewayError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
        }
        if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
          throw new GatewayError(415, 'unsupported_encoding', 'Compressed request bodies are not supported.');
        }
        timer = setTimeout(() => controller.abort(new GatewayError(408, 'request_timeout', 'Request body timed out.')), 10_000);
        body = await readBody(request, config.maxBodyBytes, controller.signal);
        clearTimeout(timer);
        let parsed: unknown;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { throw new GatewayError(400, 'invalid_json', 'Request body must be valid JSON.'); }
        if (path === '/ask') {
          ask = parseAsk(parsed, config.model);
          body = Buffer.from(JSON.stringify(ask.payload));
        }
        // 官方接口仅检查 JSON 和大小，其余字段交给上游验证，正文按字节转发。
      }
      timer = setTimeout(() => controller.abort(new GatewayError(504, 'upstream_timeout', 'Jev request timed out.')), config.timeoutMs);
      const upstreamPath = path === '/ask' ? '/v1/systemone' : url;
      const result = await abortable(this.upstream(config, expectedMethod, upstreamPath, body, controller.signal), controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (ask && result.status >= 200 && result.status < 300) {
        const answer = simplifyAnswer(result.body, ask);
        for (const [key, value] of Object.entries(result.headers)) {
          if (key !== 'content-type' && key !== 'content-encoding') response.setHeader(key, value);
        }
        json(response, result.status, answer);
      } else {
        response.writeHead(result.status, { ...result.headers, 'cache-control': 'no-store' });
        response.end(result.body);
      }
    } catch (error) {
      const failure = error instanceof GatewayError ? error :
        new GatewayError(502, 'upstream_unavailable', 'Unable to complete the Jev request.');
      if (!response.destroyed && !response.headersSent) {
        json(response, failure.status, { error: { code: failure.code, message: failure.message } });
      }
      // 不记录 error 对象，网络错误可能包含凭证、请求头或业务正文。
    } finally {
      if (timer) clearTimeout(timer);
      if (acquired) this.inFlight--;
      request.off('aborted', disconnected);
      response.off('close', disconnected);
      if (!request.complete) request.resume();
      if (!isHealth) this.log({ event: 'jev_request', method,
        path: ['/v1/models', '/v1/systemone', '/ask'].includes(path) ? path : 'unknown',
        status: response.destroyed && !response.writableEnded ? 499 : response.statusCode,
        durationMs: Date.now() - started });
    }
  }
}
