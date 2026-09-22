import http from 'node:http';
import handler from './api/index.js';

const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => void handler(req, res));
server.listen(port, '127.0.0.1', () => console.info(`Jev gateway listening on http://127.0.0.1:${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.closeAllConnections(); server.close(); });
}
