import { createServer, type Server } from 'node:http';
import client from 'prom-client';

let registry: client.Registry | undefined;

/** Shared Prometheus registry with default Node metrics. */
export function metrics(): client.Registry {
  if (!registry) {
    registry = new client.Registry();
    client.collectDefaultMetrics({ register: registry });
  }
  return registry;
}

export { client as prom };

/** Standalone `/metrics` server for processes without their own HTTP server (worker, notifier). */
export function startMetricsServer(port: number): Server {
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', metrics().contentType);
      res.end(await metrics().metrics());
    } else if (req.url === '/health') {
      res.end('ok');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(port);
  return server;
}
