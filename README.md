# Jev Gateway

部署在 Vercel 的 TypeSafe Jev 网关。支持官方 SDK 和简化的 `/ask` 接口，调用方使用网关 Token，服务端使用官方 API Key 访问固定的 `api.typesafe.ai`。

使用 Node.js 24，无运行时第三方依赖。支持本地运行和 Vercel 部署。

正式地址：<https://jev-gateway-gamma.vercel.app>。GitHub 的 `main` 分支已关联 Vercel，推送后自动部署。

| 接口 | 用途 |
| --- | --- |
| `POST /v1/systemone` | 官方 SDK 推理接口，保留 JSON 原文、上游状态码和响应 |
| `GET /v1/models` | 官方模型列表 |
| `POST /ask` | 单个问题，支持 noul、choice、score |
| `GET /healthz` | 存活检查 |
| `GET /readyz` | 本地配置检查，不验证官方 Key 有效性或上游连通性 |

业务接口要求 `Authorization: Bearer <JEV_GATEWAY_TOKEN>`。健康检查不要求 Token。

## 调用示例

`JEV_URL` 填部署的根地址，不包含 `/v1`。调用方无需持有官方 Key。

```bash
export JEV_URL='https://jev-gateway-gamma.vercel.app'
export JEV_GATEWAY_TOKEN='<你的网关 Token>'

curl --fail-with-body -sS "$JEV_URL/ask" \
  -H "Authorization: Bearer $JEV_GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"state":"The package was delivered successfully.","question":"Has the package been delivered?"}'
```

示例响应：`{"value":0.95}`。数值仅用于演示。

| 参数 | 说明 |
| --- | --- |
| `state` | 必填，字符串、对象或数组 |
| `question` | 必填，非空字符串 |
| `type` | `noul`、`choice`、`score`，默认 `noul` |
| `options` | choice 必填，1～255 个非空且不同的字符串 |
| `levels` | score 必填，2～10 个从低到高的评分描述 |
| `model` | 可选，默认 `jev-latest` |

```json
{"state":"重复扣款了","question":"属于哪类问题？","type":"choice","options":["支付","物流","其他"]}
```

```json
{"state":"服务完全不可用","question":"问题有多紧急？","type":"score","levels":["可以等待","尽快处理","立即处理"]}
```

choice 返回 `value`、`confidence`、`probabilities`。score 还返回 `legend`，分值对应 levels 的下标，可以是小数。需要批量问题或用量信息时，使用官方 SDK。

## 官方 SDK

兼容性测试使用 `@typesafe-ai/sdk@0.6.0`：

```ts
import { TypeSafeClient, noul } from '@typesafe-ai/sdk';

const client = new TypeSafeClient({
  baseURL: process.env.JEV_URL,
  apiKey: process.env.JEV_GATEWAY_TOKEN,
  timeout: 80_000,
});

const result = await client.systemOne({
  state: 'The package was delivered successfully.',
  questions: { delivered: noul('Has the package been delivered?') },
});
const models = await client.models.list();
```

Python SDK 使用 `base_url` 和 `api_key` 配置相同地址及网关 Token。网关保留上游重试提示头，自身不重试，官方 SDK 可能重试。

## 本地开发

```bash
nvm use
npm ci
cp .env.example .env.local
# 在 .env.local 填写 TYPESAFE_API_KEY、JEV_GATEWAY_TOKEN
npm run dev
```

默认监听 `127.0.0.1:3000`，可通过 `PORT` 调整。本地开发和验证命令会加载 `.env.local`。缺少凭证时 `/healthz` 可访问，`/readyz` 和业务接口返回 503。

```bash
npm run check       # 类型检查、TLS 模拟上游测试、编译
npm run verify      # 对 JEV_URL 执行真实推理和官方 SDK 验证
npm run verify -- --smoke  # 仅检查路由、配置、鉴权和参数，不调用 Jev
```

测试需要本机安装 OpenSSL，用于生成一次性的 TLS 证书。真实验证使用合成输入，会产生少量推理请求；结果写入已被 Git 忽略的 `verification-results.json`。

## Vercel 部署

将此 GitHub 仓库导入 Vercel，或使用 Vercel CLI 部署。Framework Preset 选 Other；配置文件已设置 Node.js 24、Singapore (`sin1`)、90 秒函数时限、构建命令和路由。

部署前，在 Vercel 对应环境中配置：

| 变量 | 说明 |
| --- | --- |
| `TYPESAFE_API_KEY` | 必填，TypeSafe 官方 API Key |
| `JEV_GATEWAY_TOKEN` | 必填，网关共享 Token，可用 `openssl rand -hex 32` 生成 |
| `JEV_DEFAULT_MODEL` | 默认 `jev-latest` |
| `JEV_UPSTREAM_TIMEOUT_MS` | 默认 60000，最大 70000 |
| `JEV_MAX_CONCURRENCY` | 默认 32，最大 128，按函数实例计算 |
| `JEV_MAX_BODY_BYTES` | 默认 1048576，最大 4194304 |

`NODEJS_HELPERS=0` 已在 `vercel.json` 设置，用于保留原始请求流。上游响应限制为 4 MiB，预留 Vercel 4.5 MB payload 上限的余量。

```bash
npx vercel login
npx vercel link
# 在平台配置两个必填变量，分别检查 Preview、Production 的作用范围
npx vercel pull --environment=preview
npx vercel build
npx vercel deploy --prebuilt
# 按 CLI 返回的环境和地址运行验证，再显式发布正式环境
npx vercel --prod
```

Preview 若启用 Vercel Deployment Protection，验证脚本支持环境变量 `VERCEL_AUTOMATION_BYPASS_SECRET`。正式调用请使用允许 API 访问的生产域名，由网关 Token 鉴权，避免 SDK 收到平台登录页面。

## 运行约束

上游地址固定，无法通过请求指定其他主机。业务响应不缓存；不会透传调用方 Cookie、代理控制头或其他未明确允许的请求头。日志仅记录路由、方法、状态码和耗时。

单实例并发计数用于保护实例，不是跨实例限流或总费用上限。请求正文最多读取 10 秒，上游默认等待 60 秒。客户端断开后会取消上游连接，但已经发往 Jev 的请求仍可能计费。

本服务为公网接口。从受限网络发起调用时，仍需满足调用环境自身的公网访问规则。

实现参考：[TypeSafe API](https://docs.typesafe.ai/api)、[Vercel Node.js](https://vercel.com/docs/functions/runtimes/node-js)、[Vercel 函数限制](https://vercel.com/docs/functions/limitations)。
