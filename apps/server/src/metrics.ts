import client from 'prom-client';
import type { FastifyInstance } from 'fastify';

export function registerMetrics(app: FastifyInstance) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: 'folio_' });
  const httpDuration = new client.Histogram({
    name: 'folio_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const docsSaved = new client.Counter({ name: 'folio_document_saves_total', help: 'Document content saves', registers: [registry] });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    if (route === '/metrics') return;
    httpDuration.labels(req.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
    if (route === '/api/documents/:id/content' && reply.statusCode === 200) docsSaved.inc();
  });

  app.get('/metrics', async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));
}
