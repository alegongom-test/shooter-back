import type { ClientMsg, ServerMsg } from '@horda/shared';

/**
 * WebSocket con simulación opcional de latencia y jitter (para probar el netcode en la red local).
 * Se respeta el orden de los mensajes, igual que en TCP.
 */
export class Connection {
  onJson: (msg: ServerMsg) => void = () => {};
  onBinary: (buf: ArrayBuffer) => void = () => {};
  onClose: () => void = () => {};

  private lastSendAt = 0;
  private lastRecvAt = 0;
  private closed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly lagMs: number,
    private readonly jitterMs: number,
  ) {
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev) => this.delayed('recv', () => this.dispatch(ev.data));
    ws.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      this.onClose();
    };
  }

  static open(url: string, lagMs = 0, jitterMs = 0): Promise<Connection> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new Error('Dirección de servidor no válida'));
        return;
      }
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Tiempo de espera agotado'));
      }, 6000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new Connection(ws, lagMs, jitterMs));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('No se pudo conectar'));
      };
    });
  }

  get open(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMsg): void {
    const data = JSON.stringify(msg);
    this.delayed('send', () => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    });
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }

  private dispatch(data: unknown): void {
    if (typeof data === 'string') this.onJson(JSON.parse(data) as ServerMsg);
    else if (data instanceof ArrayBuffer) this.onBinary(data);
  }

  private delayed(dir: 'send' | 'recv', fn: () => void): void {
    if (this.lagMs <= 0 && this.jitterMs <= 0) {
      fn();
      return;
    }
    const now = performance.now();
    const delay = this.lagMs / 2 + Math.random() * this.jitterMs;
    const last = dir === 'send' ? this.lastSendAt : this.lastRecvAt;
    const at = Math.max(last, now + delay);
    if (dir === 'send') this.lastSendAt = at;
    else this.lastRecvAt = at;
    setTimeout(fn, at - now);
  }
}
