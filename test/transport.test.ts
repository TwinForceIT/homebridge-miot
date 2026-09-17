import assert from 'node:assert/strict';
import { test } from 'node:test';
import dgram from 'node:dgram';
import type { RemoteInfo } from 'node:dgram';
import { EventEmitter, once } from 'node:events';
import { HELLO, decodePacket, encodePacket } from '../src/miio/codec.js';
import { MiioTransport } from '../src/miio/transport.js';

const tokenHex = '00112233445566778899aabbccddeeff';
const token = Buffer.from(tokenHex, 'hex');
const deviceId = 123456;
const timestamp = 1700000000;

test('packet matches an independently constructed Python struct + OpenSSL AES vector', () => {
  const vector = '21310060000000000001e2406553f100f377ed8d1d79ac3f690f336b80b05a00bd6a2ee30f2a04a15abd54fee183e08783e8d9106f7f0105e5f301d0562da617999f41033b4dd710a0b199fc64159dcd4fd9ec1bbd03994b6f0a9cc35fdafd72';
  const payload = { id: 42, method: 'get_properties', params: [] };
  assert.equal(encodePacket(token, deviceId, timestamp, payload).toString('hex'), vector);
  assert.deepEqual(decodePacket(token, Buffer.from(vector, 'hex')), { deviceId, timestamp, payload });
});
test('rejects corrupt, truncated and unauthenticated responses without echoing secrets', () => {
  const packet = encodePacket(token, deviceId, timestamp, { id: 1, result: [] });
  assert.throws(() => decodePacket(token, packet.subarray(0, 12)), /header/);
  assert.throws(() => decodePacket(Buffer.alloc(16), packet), /authentication/);
  packet[packet.length - 1] = packet[packet.length - 1]! ^ 1;
  assert.throws(() => decodePacket(token, packet), /authentication/);
});
interface Request { id: number; method: string; params: unknown[] }
async function peer(handler: (request: Request, reply: (value: unknown, id?: number) => void) => void) {
  const server = dgram.createSocket('udp4');
  let handshakes = 0;
  server.on('message', (packet: Buffer, info: RemoteInfo) => {
    if (packet.equals(HELLO)) {
      handshakes++;
      const answer = Buffer.from(HELLO);
      answer.writeUInt32BE(deviceId, 8);
      answer.writeUInt32BE(timestamp, 12);
      server.send(answer, info.port, info.address);
      return;
    }
    const request = decodePacket(token, packet).payload as Request;
    handler(request, (result, id = request.id) => server.send(encodePacket(token, deviceId, timestamp, { id, result }), info.port, info.address));
  });
  server.bind(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  return { server, port: address.port, get handshakes() { return handshakes; } };
}
test('UDP handshake, encrypted requests, response correlation and serialized calls', async t => {
  const methods: string[] = [];
  const mock = await peer((request, reply) => {
    methods.push(request.method);
    reply(['wrong-id'], request.id + 1);
    reply([request.method]);
  });
  const transport = new MiioTransport('127.0.0.1', tokenHex, { port: mock.port, timeout: 200 });
  t.after(() => { transport.close(); mock.server.close(); });
  const results = await Promise.all([transport.request('get_properties', []), transport.request('set_properties', [])]);
  assert.deepEqual(results, [['get_properties'], ['set_properties']]);
  assert.deepEqual(methods, ['get_properties', 'set_properties']);
  assert.equal(mock.handshakes, 1);
});
test('retries reads after a fresh handshake but does not replay a lost write', async t => {
  let reads = 0;
  let writes = 0;
  const mock = await peer((request, reply) => {
    if (request.method === 'get_properties' && ++reads === 2) reply([true]);
    if (request.method === 'set_properties') writes++;
  });
  const transport = new MiioTransport('127.0.0.1', tokenHex, { port: mock.port, timeout: 80 });
  t.after(() => { transport.close(); mock.server.close(); });
  assert.deepEqual(await transport.request('get_properties', []), [true]);
  assert.equal(mock.handshakes, 2);
  await assert.rejects(transport.request('set_properties', []), /did not respond/);
  assert.equal(writes, 1);
});
test('shutdown cancels pending and queued operations promptly', async t => {
  let received!: () => void;
  const incoming = new Promise<void>(resolve => { received = resolve; });
  const mock = await peer(() => received());
  const transport = new MiioTransport('127.0.0.1', tokenHex, { port: mock.port, timeout: 1000 });
  t.after(() => mock.server.close());
  const first = transport.request('get_properties', []);
  const second = transport.request('get_properties', []);
  const assertions = [assert.rejects(first, /closed/), assert.rejects(second, /closed/)];
  await incoming;
  transport.close();
  await Promise.all(assertions);
  await assert.rejects(transport.request('get_properties', []), /closed/);
});

for (const failure of ['connect-callback', 'connect-throw', 'send-throw'] as const) {
  test(`UDP ${failure} failure rejects safely and closes its socket`, async t => {
    let sends = 0;
    let closes = 0;
    class FailedSocket extends EventEmitter {
      connect(_port: number, _host: string, callback: (error?: Error) => void): void {
        if (failure === 'connect-throw') throw new Error('Sensitive network details');
        queueMicrotask(() => callback(failure === 'connect-callback'
          ? new Error('Sensitive network details') : undefined));
      }
      send(): void {
        sends++;
        throw new Error('Sensitive socket details');
      }
      close(): void { closes++; }
    }
    t.mock.method(dgram, 'createSocket', () => new FailedSocket() as unknown as dgram.Socket);
    const transport = new MiioTransport('192.0.2.10', tokenHex, { timeout: 1000 });
    t.after(() => transport.close());
    await assert.rejects(transport.request('set_properties', []), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, failure === 'send-throw' ? /Cannot send/ : /Cannot connect/);
      assert.doesNotMatch(error.message, /Sensitive/);
      return true;
    });
    assert.equal(sends, failure === 'send-throw' ? 1 : 0);
    assert.equal(closes, 1);
    transport.close();
    assert.equal(closes, 1, 'failure removes its cancellation callback and timer');
  });
}
