// Uses synthetic inputs. A full run makes a small number of real inference requests.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { TypeSafeClient, noul, choice, score } from '@typesafe-ai/sdk';

const baseURL = process.env.JEV_URL?.replace(/\/$/, '');
const token = process.env.JEV_GATEWAY_TOKEN;
if (!baseURL || !token) throw new Error('Set JEV_URL and JEV_GATEWAY_TOKEN.');
if (!/^https?:\/\//.test(baseURL)) throw new Error('JEV_URL must be an HTTP(S) URL without a trailing /v1.');
const smoke = process.argv.includes('--smoke');
const protection = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {};
const report = { date: new Date().toISOString(), baseURL, mode: smoke ? 'smoke' : 'full', checks: [], passed: false };

async function call(name, path, status, { body, rawBody, authorization = `Bearer ${token}` } = {}) {
  const start = Date.now();
  const res = await fetch(baseURL + path, {
    method: body !== undefined || rawBody !== undefined ? 'POST' : 'GET',
    headers: { ...protection, 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(80_000),
    redirect: 'manual',
  });
  const raw = await res.text();
  let value;
  try { value = JSON.parse(raw); } catch { value = raw.slice(0, 1000); }
  report.checks.push({ name, status: res.status, durationMs: Date.now() - start,
    requestId: res.headers.get('x-vercel-id'), response: value });
  console.log(`${name}: HTTP ${res.status}`);
  assert.equal(res.status, status, `${name}: HTTP ${res.status}, expected ${status}`);
  return value;
}

try {
  await call('health', '/healthz', 200, { authorization: '' });
  await call('ready', '/readyz', 200, { authorization: '' });
  await call('missing token', '/v1/models', 401, { authorization: '' });
  await call('wrong token', '/v1/models', 401, { authorization: 'Bearer invalid-test-token' });
  await call('invalid JSON', '/ask', 400, { rawBody: '{invalid' });
  await call('invalid question', '/ask', 400, { body: { state: 'Synthetic input' } });
  await call('unknown route', '/unknown', 404);
  if (!smoke) {
    const models = await call('models', '/v1/models', 200);
    assert(Array.isArray(models.models) && models.models.length > 0);
    const state = 'The package was delivered successfully. No further action is needed.';
    const probability = await call('ask noul', '/ask', 200, { body: { state, question: 'Has the package been delivered?' } });
    assert(typeof probability.value === 'number' && probability.value >= 0 && probability.value <= 1);
    const category = await call('ask choice', '/ask', 200, { body: {
      state, question: 'What is the delivery status?', type: 'choice', options: ['delivered', 'pending'],
    } });
    assert(['delivered', 'pending'].includes(category.value));
    const rating = await call('ask score', '/ask', 200, { body: {
      state, question: 'How urgent is further action?', type: 'score', levels: ['not urgent', 'urgent'],
    } });
    assert(typeof rating.value === 'number' && rating.value >= 0 && rating.value <= 1);
    const client = new TypeSafeClient({ baseURL, apiKey: token, timeout: 80_000,
      retry: { maxRetries: 0 }, logLevel: 'off', defaultHeaders: protection });
    const start = Date.now();
    const result = await client.systemOne({ state, questions: {
      delivered: noul('Has the package been delivered?'),
      status: choice('What is the delivery status?', { delivered: null, pending: null }),
      urgency: score('How urgent is further action?', ['not urgent', 'urgent']),
    } });
    assert.equal(result.answers.delivered.type, 'noul');
    assert.equal(result.answers.status.type, 'choice');
    assert.equal(result.answers.urgency.type, 'score');
    report.checks.push({ name: 'official SDK mixed questions', durationMs: Date.now() - start, response: result });
    const sdkModels = await client.models.list();
    assert(Array.isArray(sdkModels) && sdkModels.length > 0);
    report.checks.push({ name: 'official SDK model list', count: sdkModels.length });
  }
  report.passed = true;
  console.log(smoke ? 'Smoke checks passed; real inference was not tested.' : 'All checks passed.');
} catch (error) {
  report.error = { name: error.name, message: error.message };
  console.error(error.message);
  process.exitCode = 1;
} finally {
  writeFileSync('verification-results.json', JSON.stringify(report, null, 2) + '\n');
}
