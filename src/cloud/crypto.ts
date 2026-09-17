import { createHash, randomBytes } from 'node:crypto';

/** Xiaomi's legacy cloud API requires RC4-drop1024; TLS remains mandatory. */
export function rc4(key: Uint8Array, input: Uint8Array, drop = 1024): Buffer {
  if (key.length === 0) {
    throw new Error('An RC4 key is required.');
  }
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i]! + key[i % key.length]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  const output = Buffer.alloc(input.length);
  let i = 0;
  j = 0;
  for (let offset = -drop; offset < input.length; offset++) {
    i = (i + 1) & 255;
    j = (j + state[i]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
    const byte = state[(state[i]! + state[j]!) & 255]!;
    if (offset >= 0) {
      output[offset] = input[offset]! ^ byte;
    }
  }
  return output;
}

export function createNonce(now: number): string {
  const nonce = Buffer.alloc(12);
  randomBytes(8).copy(nonce);
  nonce.writeUInt32BE(Math.floor(now / 60_000), 8);
  return nonce.toString('base64');
}

export function signNonce(security: string, nonce: string): string {
  return createHash('sha256')
    .update(Buffer.from(security, 'base64'))
    .update(Buffer.from(nonce, 'base64'))
    .digest('base64');
}

function signature(path: string, nonce: string, fields: Record<string, string>): string {
  const values = ['POST', path, ...Object.entries(fields).map(([key, value]) => `${key}=${value}`), nonce];
  return createHash('sha1').update(values.join('&')).digest('base64');
}

export function encryptRequest(path: string, data: unknown, security: string, nonce: string): {
  body: URLSearchParams;
  signedNonce: string;
} {
  const signedNonce = signNonce(security, nonce);
  const fields: Record<string, string> = { data: JSON.stringify(data) };
  fields.rc4_hash__ = signature(path, signedNonce, fields);
  for (const [key, value] of Object.entries(fields)) {
    fields[key] = rc4(Buffer.from(signedNonce, 'base64'), Buffer.from(value)).toString('base64');
  }
  return {
    signedNonce,
    body: new URLSearchParams({
      ...fields,
      signature: signature(path, signedNonce, fields),
      ssecurity: security,
      _nonce: nonce,
    }),
  };
}

export function decryptResponse(payload: string, signedNonce: string): string {
  return rc4(Buffer.from(signedNonce, 'base64'), Buffer.from(payload, 'base64')).toString('utf8');
}
