import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decodePacket, encodePacket, header, HELLO } from './codec.js';

export interface MiotTransport {
  request(method: string, params: unknown[]): Promise<unknown>;
  close(): void;
}
interface Handshake { deviceId: number; timestamp: number; at: number }
export interface TransportOptions { timeout?: number; port?: number; handshakeMaxAge?: number }
export class MiioTransport implements MiotTransport {
  private readonly token: Buffer;
  private readonly timeout: number;
  private readonly port: number;
  private readonly handshakeMaxAge: number;
  private handshake?: Handshake;
  private sequence = randomInt(1, 10000);
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly pending = new Set<() => void>();

  constructor(private readonly host: string, token: string, options: TransportOptions = {}) {
    if (!/^[a-f0-9]{32}$/i.test(token)) throw new Error('Invalid device token.');
    this.token = Buffer.from(token, 'hex');
    this.timeout = options.timeout ?? 1500;
    this.port = options.port ?? 54321;
    this.handshakeMaxAge = options.handshakeMaxAge ?? 60_000;
  }
  request(method: string, params: unknown[]): Promise<unknown> {
    const job = this.queue.then(() => this.perform(method, params));
    this.queue = job.catch(() => undefined);
    return job;
  }
  close(): void {
    this.closed = true;
    this.handshake = undefined;
    for (const cancel of this.pending) cancel();
  }
  private async perform(method: string, params: unknown[]): Promise<unknown> {
    if (this.closed) throw new Error('Device connection is closed.');
    // Only idempotent reads retry. An unanswered write may already have succeeded.
    const attempts = method === 'get_properties' || method === 'miIO.info' ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        if (!this.handshake || performance.now() - this.handshake.at > this.handshakeMaxAge) {
          const response = await this.exchange(HELLO, packet => packet.length === 32 ? header(packet) : undefined);
          this.handshake = { ...response, at: performance.now() };
        }
        const session = this.handshake;
        const id = this.sequence = (this.sequence % 999999) + 1;
        const timestamp = session.timestamp + Math.floor((performance.now() - session.at) / 1000);
        const packet = encodePacket(this.token, session.deviceId, timestamp, { id, method, params });
        const payload = await this.exchange(packet, response => {
          const decoded = decodePacket(this.token, response);
          if (decoded.deviceId !== session.deviceId || !isRecord(decoded.payload) || decoded.payload.id !== id) return undefined;
          return decoded.payload;
        });
        if (isRecord(payload.error)) {
          const code = typeof payload.error.code === 'number' ? payload.error.code : 'unknown';
          // Firmware error text is untrusted and may echo request parameters.
          throw new Error(`miIO command failed (code ${code}).`);
        }
        if (!('result' in payload)) throw new Error('miIO response is missing its result.');
        return payload.result;
      } catch (error) {
        this.handshake = undefined;
        if (this.closed || attempt === attempts - 1) throw error;
      }
    }
    throw new Error('Device request failed.');
  }
  private exchange<T>(packet: Buffer, accept: (data: Buffer) => T | undefined): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Device connection is closed.'));
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      let finished = false;
      const finish = (error?: Error, result?: T): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pending.delete(cancel);
        try { socket.close(); } catch { /* Not bound yet. */ }
        if (error) reject(error); else resolve(result as T);
      };
      const cancel = (): void => finish(new Error('Device connection is closed.'));
      this.pending.add(cancel);
      const timer = setTimeout(() => finish(new Error('Device did not respond. Check its IP address, token and UDP port 54321.')), this.timeout);
      socket.on('error', () => finish(new Error('Cannot communicate with the device over UDP.')));
      socket.on('message', data => {
        try {
          const result = accept(data);
          if (result !== undefined) finish(undefined, result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Invalid device response.'));
        }
      });
      // Connected UDP only accepts packets from the configured device and port.
      try {
        socket.connect(this.port, this.host, (error?: Error) => {
          if (finished) return;
          // Node may deliver connect failures to the callback instead of 'error'.
          if (error) { finish(new Error('Cannot connect to the device over UDP.')); return; }
          try {
            socket.send(packet, sendError => { if (sendError) finish(new Error('Cannot send the device request.')); });
          } catch {
            finish(new Error('Cannot send the device request.'));
          }
        });
      } catch {
        finish(new Error('Cannot connect to the device over UDP.'));
      }
    });
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
