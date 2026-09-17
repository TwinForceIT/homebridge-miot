import { createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

export const HELLO = Buffer.from('21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex');
const md5 = (data: Buffer): Buffer => createHash('md5').update(data).digest();
function keys(token: Buffer): { key: Buffer; iv: Buffer } {
  if (token.length !== 16) throw new Error('Invalid miIO token length.');
  const key = md5(token);
  return { key, iv: md5(Buffer.concat([key, token])) };
}
export function header(packet: Buffer): { deviceId: number; timestamp: number } {
  if (packet.length < 32 || packet.readUInt16BE(0) !== 0x2131 || packet.readUInt16BE(2) !== packet.length) {
    throw new Error('Invalid miIO packet header.');
  }
  return { deviceId: packet.readUInt32BE(8), timestamp: packet.readUInt32BE(12) };
}
export function encodePacket(token: Buffer, deviceId: number, timestamp: number, payload: unknown): Buffer {
  const { key, iv } = keys(token);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload) + '\0'), cipher.final()]);
  const packet = Buffer.alloc(32 + encrypted.length);
  packet.writeUInt16BE(0x2131, 0);
  packet.writeUInt16BE(packet.length, 2);
  packet.writeUInt32BE(deviceId, 8);
  packet.writeUInt32BE(timestamp >>> 0, 12);
  encrypted.copy(packet, 32);
  md5(Buffer.concat([packet.subarray(0, 16), token, encrypted])).copy(packet, 16);
  return packet;
}
export function decodePacket(token: Buffer, packet: Buffer): { deviceId: number; timestamp: number; payload: unknown } {
  const info = header(packet);
  if (packet.length === 32) throw new Error('miIO response contains no data.');
  const expected = md5(Buffer.concat([packet.subarray(0, 16), token, packet.subarray(32)]));
  if (!timingSafeEqual(expected, packet.subarray(16, 32))) throw new Error('miIO authentication failed. Check the device token.');
  const { key, iv } = keys(token);
  const cipher = createDecipheriv('aes-128-cbc', key, iv);
  try {
    const text = Buffer.concat([cipher.update(packet.subarray(32)), cipher.final()]).toString('utf8').replace(/\0+$/, '');
    return { ...info, payload: JSON.parse(text) as unknown };
  } catch {
    throw new Error('Cannot decode miIO response. Check the device token.');
  }
}
