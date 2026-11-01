type Handler = (msg: any) => void;

/** Single shared websocket with automatic reconnect and room re-join. */
class Realtime {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private docId: string | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.docId) this.send({ type: 'join', docId: this.docId });
      this.emit({ type: 'connected' });
      this.ping = setInterval(() => this.send({ type: 'ping' }), 25_000);
    };
    ws.onmessage = (e) => {
      try {
        this.emit(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.emit({ type: 'disconnected' });
      if (this.stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private emit(msg: any) {
    for (const h of this.handlers) h(msg);
  }

  join(docId: string) {
    this.docId = docId;
    this.send({ type: 'join', docId });
  }

  leave(docId: string) {
    if (this.docId !== docId) return;
    this.docId = null;
    this.send({ type: 'leave' });
  }

  on(h: Handler) {
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }
}

export const realtime = new Realtime();
