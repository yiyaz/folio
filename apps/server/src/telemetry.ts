/**
 * OpenTelemetry tracing, enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * Must be imported before anything else so auto-instrumentation can patch modules.
 */
export async function startTelemetry() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'folio',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  });
  sdk.start();
  return sdk;
}
