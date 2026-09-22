import { configurationError } from './errors.js';

export interface GatewayConfig {
  token: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxConcurrency: number;
  maxBodyBytes: number;
}

function credential(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value || !/^[\x21-\x7e]+$/.test(value)) throw configurationError(name);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  if (env[name] === undefined) return fallback;
  if (!/^\d+$/.test(env[name]!)) throw configurationError(name);
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw configurationError(name);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    token: credential(env, 'JEV_GATEWAY_TOKEN'),
    apiKey: credential(env, 'TYPESAFE_API_KEY'),
    model: env.JEV_DEFAULT_MODEL?.trim() || 'jev-latest',
    // Keep the total handler duration below the configured 90-second function limit.
    timeoutMs: integer(env, 'JEV_UPSTREAM_TIMEOUT_MS', 60_000, 70_000),
    maxConcurrency: integer(env, 'JEV_MAX_CONCURRENCY', 32, 128),
    maxBodyBytes: integer(env, 'JEV_MAX_BODY_BYTES', 1024 * 1024, 4 * 1024 * 1024),
  };
}
