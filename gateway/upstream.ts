import https from 'node:https';
import type { RequestOptions } from 'node:https';
import type { GatewayConfig } from './config.js';
import { GatewayError } from './errors.js';

const UPSTREAM_HOST = 'api.typesafe.ai';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RESPONSE_HEADERS = new Set(['content-type', 'content-encoding', 'retry-after', 'retry-after-ms',
  'x-typesafe-request-id', 'x-request-id']);

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export type UpstreamCall = (config: GatewayConfig, method: 'GET' | 'POST', path: string,
  body: Buffer | undefined, signal: AbortSignal) => Promise<UpstreamResponse>;

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function requestOptions(config: GatewayConfig, method: 'GET' | 'POST', path: string,
  body: Buffer | undefined): RequestOptions {
  if (!/^\/v1\/(systemone|models)(\?.*)?$/.test(path) || /[\r\n]/.test(path)) {
    throw new GatewayError(400, 'invalid_path', 'Unsupported upstream path.');
  }
  const headers: Record<string, string | number> = {
    host: UPSTREAM_HOST,
    authorization: `Bearer ${config.apiKey}`,
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'jev-gateway/1.0',
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = body.length;
  }
  return { hostname: UPSTREAM_HOST, port: 443, method, path, headers };
}

// The optional requester permits a local TLS test server without a configurable production upstream.
export function createUpstream(requester: typeof https.request = https.request): UpstreamCall {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16, timeout: 60_000 });
  return async (config, method, path, body, signal) => {
    if (signal.aborted) throw signal.reason;
    const options = requestOptions(config, method, path, body);
    return new Promise<UpstreamResponse>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const request = requester({ ...options, agent });
      const onAbort = () => request.destroy(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      request.once('close', () => signal.removeEventListener('abort', onAbort));
      request.once('error', error => reject(signal.aborted ? signal.reason :
        error instanceof GatewayError ? error : new GatewayError(502, 'upstream_unavailable', 'Unable to reach Jev.')));
      request.once('response', response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new GatewayError(502, 'upstream_response_too_large', 'Jev response exceeds the size limit.'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', () => reject(signal.aborted ? signal.reason :
          new GatewayError(502, 'upstream_unavailable', 'Jev response was interrupted.')));
        response.once('end', () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === 'string' && (RESPONSE_HEADERS.has(name) || name.startsWith('x-ratelimit-'))) headers[name] = value;
          }
          resolve({ status: response.statusCode || 502, headers, body: Buffer.concat(chunks) });
        });
      });
      request.end(body);
    });
  };
}
