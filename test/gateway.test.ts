import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeSafeClient, noul, choice, score } from '@typesafe-ai/sdk';
import { JevGateway, type RequestLog } from '../gateway/handler.js';
import { readConfig, type GatewayConfig } from '../gateway/config.js';
import { createUpstream, requestOptions } from '../gateway/upstream.js';
import handler from '../api/index.js';

const token = 'synthetic-gateway-token';
const apiKey = 'synthetic-official-key';
const model = { name: 'mock-model', description: 'Synthetic model', release_date: '2026-09-22' };
const answer = { model: model.name, answers: { result: { type: 'noul', noul: 0.95 } },
  usage: { input_tokens: 10, output_tokens: 1 } };
interface Captured { path: string; headers: IncomingHttpHeaders; body: string }
let temp: string;
let certificate: Buffer;
let key: Buffer;
let upstream: https.Server;
let server: http.Server;
let testAgent: https.Agent;
let baseURL: string;
let config: GatewayConfig;
let calls: Captured[];
let logs: RequestLog[];
let respond: (response: ServerResponse, call: Captured) => void;

before(() => {
  temp = mkdtempSync(join(tmpdir(), 'jev-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', join(temp, 'key.pem'), '-out', join(temp, 'cert.pem')], { stdio: 'ignore' });
  certificate = readFileSync(join(temp, 'cert.pem'));
  key = readFileSync(join(temp, 'key.pem'));
});
after(() => rmSync(temp, { recursive: true, force: true }));

async function listen(s: http.Server | https.Server) {
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  return (s.address() as { port: number }).port;
}
async function close(s: http.Server | https.Server) {
  s.closeAllConnections();
  await new Promise<void>(resolve => s.close(() => resolve()));
}
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(baseURL + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(async () => {
  config = readConfig({ JEV_GATEWAY_TOKEN: token, TYPESAFE_API_KEY: apiKey });
  calls = []; logs = [];
  respond = res => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer)); };
  upstream = https.createServer({ cert: certificate, key }, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() };
    calls.push(call);
    respond(res, call);
  });
  const port = await listen(upstream);
  testAgent = new https.Agent({ keepAlive: true, ca: certificate });
  const requester = ((options: https.RequestOptions) => https.request({ ...options,
    hostname: '127.0.0.1', servername: 'localhost', port, agent: testAgent })) as typeof https.request;
  const gateway = new JevGateway(() => config, createUpstream(requester), entry => logs.push(entry));
  server = http.createServer((req, res) => void gateway.handle(req, res));
  baseURL = `http://127.0.0.1:${await listen(server)}`;
});
afterEach(async () => { testAgent.destroy(); await close(server); await close(upstream); });

test('official SDK mixed questions and models pass through a real TLS upstream', async () => {
  const payload = { state: { text: 'synthetic' }, model: 'mock-model', questions: {
    result: noul('Relevant?'), category: choice('Category?', { A: null, B: null }), urgency: score('Urgency?', ['low', 'high']),
  } };
  const mixed = { ...answer, answers: { ...answer.answers,
    category: { type: 'choice', choice: 'A', probabilities: { A: 0.9, B: 0.1 }, confidence: 0.8 },
    urgency: { type: 'score', score: 1, probabilities: { '0': 0, '1': 1 }, legend: { '0': 'low', '1': 'high' }, confidence: 1 },
  } };
  respond = (res, call) => { res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(call.path === '/v1/models' ? { models: [model] } : mixed)); };
  const client = new TypeSafeClient({ baseURL, apiKey: token, logLevel: 'off' });
  assert.deepEqual(await client.systemOne(payload), mixed);
  assert.deepEqual(await client.models.list(), [model]);
  assert.deepEqual(JSON.parse(calls[0].body), JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(calls.map(call => call.path), ['/v1/systemone', '/v1/models']);
});

test('raw JSON and query survive; only explicit upstream headers are sent', async () => {
  const body = '{ "state": "synthetic", "questions": {}, "future_field": [1] }';
  const res = await fetch(baseURL + '/v1/systemone?future=1', { method: 'POST', body,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      cookie: 'session=private', 'proxy-authorization': 'private', 'x-private-token': 'private',
      'x-forwarded-host': 'attacker.example', 'destination-domain': 'attacker.example' } });
  assert.equal(res.status, 200);
  assert.equal(calls[0].body, body);
  assert.equal(calls[0].path, '/v1/systemone?future=1');
  assert.equal(calls[0].headers.host, 'api.typesafe.ai');
  assert.equal(calls[0].headers.authorization, `Bearer ${apiKey}`);
  for (const name of ['cookie', 'proxy-authorization', 'x-private-token', 'x-forwarded-host', 'destination-domain']) {
    assert.equal(calls[0].headers[name], undefined);
  }
  assert.doesNotMatch(JSON.stringify(logs), /synthetic|private|future|token/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('authentication happens before JSON parsing and any upstream call', async () => {
  for (const authorization of ['', 'Bearer wrong', 'Basic wrong']) {
    const res = await fetch(baseURL + '/ask', { method: 'POST', body: '{bad',
      headers: { authorization, 'content-type': 'application/json' } });
    assert.equal(res.status, 401);
  }
  assert.equal(calls.length, 0);
});

test('ask noul maps to the default model', async () => {
  const res = await request('/ask', { state: ['synthetic'], question: 'Relevant?' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { value: 0.95 });
  assert.deepEqual(JSON.parse(calls[0].body), { state: ['synthetic'], model: 'jev-latest',
    questions: { result: { type: 'noul', instructions: 'Relevant?' } } });
});

test('choice preserves special option names without prototype changes', async () => {
  respond = res => res.end('{"answers":{"result":{"type":"choice","choice":"__proto__","confidence":0.8,"probabilities":{"__proto__":0.9,"other":0.1}}}}');
  const res = await request('/ask', { state: {}, question: 'Which?', type: 'choice', options: ['__proto__', 'other'] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).value, '__proto__');
  assert.deepEqual(Object.keys(JSON.parse(calls[0].body).questions.result.criteria), ['__proto__', 'other']);
});

test('score preserves fractional values, probabilities and legend', async () => {
  const result = { type: 'score', score: 0.8, confidence: 0.6,
    probabilities: { '0': 0.2, '1': 0.8 }, legend: { '0': 'low', '1': 'high' } };
  respond = res => res.end(JSON.stringify({ answers: { result } }));
  const res = await request('/ask', { state: 'x', question: 'How much?', type: 'score', levels: ['low', 'high'], model: 'custom-model' });
  assert.deepEqual(await res.json(), { value: 0.8, confidence: result.confidence,
    probabilities: result.probabilities, legend: result.legend });
  assert.equal(JSON.parse(calls[0].body).model, 'custom-model');
});

for (const input of [{}, { state: null, question: 'Q' }, { state: 'x', question: '' },
  { state: 'x', question: 'Q', type: 'chat' }, { state: 'x', question: 'Q', options: ['A'] },
  { state: 'x', question: 'Q', type: 'choice', options: ['A', 'A'] },
  { state: 'x', question: 'Q', type: 'score', levels: ['low'] }, { state: 'x', question: 'Q', typo: true }]) {
  test(`invalid ask input does not call upstream: ${JSON.stringify(input)}`, async () => {
    assert.equal((await request('/ask', input)).status, 400);
    assert.equal(calls.length, 0);
  });
}

test('enforces JSON, request size and route/method allowlist', async () => {
  config.maxBodyBytes = 64;
  assert.equal((await fetch(baseURL + '/ask', { method: 'POST', body: '{', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json' } })).status, 400);
  assert.equal((await request('/ask', { state: 'x'.repeat(100), question: 'Q' })).status, 413);
  assert.equal((await request('/ask', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request('/ask', {}, { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await request('/v1/other')).status, 404);
  assert.equal((await request('/v1/models', {})).status, 405);
  assert.equal(calls.length, 0);
});

for (const status of [401, 422, 429, 529]) {
  test(`preserves upstream ${status}, body and retry headers without retrying`, async () => {
    respond = res => { res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '2',
      'retry-after-ms': '100', 'x-typesafe-request-id': 'upstream-id', 'set-cookie': 'secret=x', 'x-private': 'x' });
    res.end('{"detail":"synthetic error"}'); };
    const res = await request('/ask', { state: 'x', question: 'Q' });
    assert.equal(res.status, status);
    assert.equal(await res.text(), '{"detail":"synthetic error"}');
    assert.equal(res.headers.get('retry-after'), '2');
    assert.equal(res.headers.get('x-typesafe-request-id'), 'upstream-id');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('x-private'), null);
    assert.equal(calls.length, 1);
  });
}

test('SDK retries once for 429; the gateway does not multiply retries', async () => {
  respond = res => {
    if (calls.length === 1) { res.writeHead(429, { 'retry-after-ms': '1' }); res.end('{"detail":"busy"}'); }
    else res.end(JSON.stringify(answer));
  };
  const client = new TypeSafeClient({ baseURL, apiKey: token, logLevel: 'off' });
  assert.deepEqual(await client.systemOne({ state: 'x', questions: { result: noul('Q') } }), answer);
  assert.equal(calls.length, 2);
});

test('does not follow upstream redirects', async () => {
  respond = res => { res.writeHead(307, { location: 'https://other.example/secret' }); res.end('redirect'); };
  const res = await request('/v1/models');
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), null);
  assert.equal(calls.length, 1);
});

test('malformed successful answers become 502', async () => {
  for (const body of ['not-json', '{}', '{"answers":{"result":{"type":"noul","noul":2}}}']) {
    respond = res => res.end(body);
    assert.equal((await request('/ask', { state: 'x', question: 'Q' })).status, 502);
  }
});

test('concurrency is shared across routes, times out and recovers', async () => {
  config.maxConcurrency = 1; config.timeoutMs = 200;
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  respond = () => reached();
  const pending = request('/ask', { state: 'x', question: 'Q' });
  await started;
  const limited = await request('/v1/models');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal((await pending).status, 504);
  respond = res => res.end('{"models":[]}');
  assert.equal((await request('/v1/models')).status, 200);
});

test('client disconnect cancels the upstream socket and releases concurrency', async () => {
  config.maxConcurrency = 1;
  let reached!: () => void;
  let closed!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  respond = res => { res.once('close', closed); reached(); };
  const abort = new AbortController();
  const pending = fetch(baseURL + '/v1/models', { headers: { authorization: `Bearer ${token}` }, signal: abort.signal }).catch(() => undefined);
  await started; abort.abort(); await pending; await disconnected;
  respond = res => res.end('{"models":[]}');
  assert.equal((await request('/v1/models')).status, 200);
});

test('upstream TLS errors are sanitized', async () => {
  testAgent.destroy();
  // No trusted CA: the same self-signed local upstream must now fail verification.
  testAgent = new https.Agent();
  const res = await request('/v1/models');
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /synthetic-official-key|CERT|localhost/);
  assert.equal(calls.length, 0);
});

test('bounds upstream responses below the platform payload limit', async () => {
  respond = res => res.end(Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
  assert.equal((await request('/v1/models')).status, 502);
});

test('destination is fixed and configuration rejects unsafe or unsupported values', () => {
  assert.equal(requestOptions(config, 'GET', '/v1/models?x=1', undefined).hostname, 'api.typesafe.ai');
  for (const path of ['https://other.example/', '//other.example', '/v1/models\r\nInjected: x']) {
    assert.throws(() => requestOptions(config, 'GET', path, undefined), /Unsupported upstream path/);
  }
  assert.throws(() => readConfig({}), /JEV_GATEWAY_TOKEN/);
  assert.throws(() => readConfig({ JEV_GATEWAY_TOKEN: token }), /TYPESAFE_API_KEY/);
  const env = { JEV_GATEWAY_TOKEN: token, TYPESAFE_API_KEY: apiKey };
  assert.throws(() => readConfig({ ...env, JEV_GATEWAY_TOKEN: 'has whitespace' }), /JEV_GATEWAY_TOKEN/);
  assert.throws(() => readConfig({ ...env, JEV_UPSTREAM_TIMEOUT_MS: '71000' }), /JEV_UPSTREAM_TIMEOUT_MS/);
  assert.throws(() => readConfig({ ...env, JEV_MAX_BODY_BYTES: '8000000' }), /JEV_MAX_BODY_BYTES/);
});

test('Vercel entry preserves routes and health works without configured credentials', async () => {
  const names = ['TYPESAFE_API_KEY', 'JEV_GATEWAY_TOKEN'] as const;
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  const entry = http.createServer((req, res) => void handler(req, res));
  const url = `http://127.0.0.1:${await listen(entry)}`;
  try {
    assert.equal((await fetch(url + '/healthz')).status, 200);
    assert.equal((await fetch(url + '/readyz')).status, 503);
    Object.assign(process.env, { JEV_GATEWAY_TOKEN: token, TYPESAFE_API_KEY: apiKey });
    assert.equal((await fetch(url + '/readyz')).status, 200);
    assert.equal((await fetch(url + '/v1/models?x=1')).status, 401);
    assert.equal((await fetch(url + '/ask', { method: 'POST', body: '{bad',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })).status, 400);
  } finally {
    await close(entry);
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});
