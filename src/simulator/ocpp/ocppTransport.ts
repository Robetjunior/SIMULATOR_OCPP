type PendingCall = {
  action: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface TransportSocket {
  send(raw: string): void;
  close(): void;
}

export class OcppTransport {
  private pending = new Map<string, PendingCall>();
  private messageCounter = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly socket: TransportSocket) {}

  sendCall(action: string, payload: Record<string, unknown>, timeoutMs = 20000): Promise<unknown> {
    const messageId = `msg_${Date.now()}_${++this.messageCounter}`;
    const frame = JSON.stringify([2, messageId, action, payload]);
    this.socket.send(frame);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Timeout aguardando resposta de ${action}`));
      }, timeoutMs);
      this.pending.set(messageId, { action, resolve, reject, timeout });
    });
  }

  handleIncoming(raw: string): { type: number; action?: string; payload?: unknown } | null {
    const frame = JSON.parse(raw) as [number, string, unknown, unknown, unknown?];
    const [type, messageId, p3, p4, p5] = frame;
    if (type === 3) {
      const pending = this.pending.get(messageId);
      if (!pending) return { type };
      clearTimeout(pending.timeout);
      this.pending.delete(messageId);
      pending.resolve(p3);
      return { type };
    }
    if (type === 4) {
      const pending = this.pending.get(messageId);
      if (!pending) return { type };
      clearTimeout(pending.timeout);
      this.pending.delete(messageId);
      pending.reject(new Error(`CALLERROR ${pending.action}: ${String(p3)} ${String(p4 || "")} ${JSON.stringify(p5 || {})}`));
      return { type };
    }
    if (type === 2) {
      return { type, action: String(p3), payload: p4 };
    }
    return null;
  }

  startHeartbeat(intervalSec: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendCall("Heartbeat", {}).catch(() => undefined);
    }, Math.max(1, intervalSec) * 1000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
