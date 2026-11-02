import { startTelemetry } from './telemetry.js';

const otel = await startTelemetry();
const { loadConfig } = await import('./config.js');
const { buildApp } = await import('./app.js');

const cfg = loadConfig();
const app = await buildApp(cfg, { runMigrations: process.env.MIGRATE_ON_START !== 'false' });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  app.startDraining();
  // give the load balancer time to notice /readyz failing before closing sockets
  const grace = Number(process.env.SHUTDOWN_GRACE_MS ?? 5000);
  setTimeout(() => process.exit(1), grace + 15000).unref();
  await new Promise((r) => setTimeout(r, cfg.NODE_ENV === 'production' ? grace : 0));
  await app.close();
  await otel?.shutdown().catch(() => {});
  process.exit(0);
}
process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  // state may be corrupt: log, then let the orchestrator restart us
  app.log.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: cfg.PORT, host: cfg.HOST });
