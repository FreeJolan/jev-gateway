import type { IncomingMessage, ServerResponse } from 'node:http';
import { JevGateway } from '../gateway/handler.js';

// Reuse connections and the per-instance concurrency counter across invocations.
const gateway = new JevGateway();

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await gateway.handle(request, response);
}
