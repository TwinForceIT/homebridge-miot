import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupportedModel } from '../src/devices/registry.js';

// These JavaScript modules are shipped unchanged to Homebridge and the browser.
const sessionModule: string = new URL('../homebridge-ui/cloud-session.js', import.meta.url).href;
const configModule: string = new URL('../homebridge-ui/public/config.js', import.meta.url).href;
const { CloudSession } = await import(sessionModule);
const { mergeDevices } = await import(configModule);

const TOKEN = '1234567890abcdef1234567890abcdef';
const DEVICE = { did: '123', name: 'Purifier', model: 'zhimi.airp.cpa4', localip: '192.168.1.50', token: TOKEN };

function setup(devices = [DEVICE], clock = { value: 0 }) {
  const client = {
    resets: 0,
    async startQrLogin() { return { qrImageUrl: 'https://account.xiaomi.com/qr', loginUrl: 'https://account.xiaomi.com/login', expiresAt: 100_000 }; },
    async pollQrLogin() { return 'authenticated'; },
    async getDevices() { return devices; },
    reset() { this.resets += 1; },
  };
  const session = new CloudSession({
    createClient: () => client,
    regions: ['de', 'cn'],
    isSupportedModel,
    now: () => clock.value,
  });
  return { session, client, clock };
}

test('cloud preview excludes credentials; only selected configured devices expose local tokens', async () => {
  const { session } = setup();
  try {
    const { sessionId } = await session.start('de');
    assert.throws(() => session.select(sessionId, ['123']), { code: 'AUTH_REQUIRED' });
    await session.poll(sessionId);
    const preview = await session.devices(sessionId);
    assert.equal(preview[0].canImport, true);
    assert.equal('token' in preview[0], false);
    assert.equal(JSON.stringify(preview).includes(TOKEN), false);
    assert.deepEqual(session.select(sessionId, ['123', '123']), [{
      name: 'Purifier', model: DEVICE.model, host: DEVICE.localip, token: TOKEN, did: '123', enabled: true,
    }]);
    assert.throws(() => session.select(sessionId, ['another-account-device']), { code: 'INVALID_SELECTION' });
  } finally { session.reset(); }
});

test('onboarding rejects unsupported models, unusable tokens, and non-IPv4 addresses', async () => {
  const { session } = setup([
    { ...DEVICE, did: 'unsupported', model: 'vacuum.unknown' },
    { ...DEVICE, did: 'no-token', token: '0'.repeat(32) },
    { ...DEVICE, did: 'ipv6', localip: '::1' },
  ]);
  try {
    const { sessionId } = await session.start('de');
    await session.poll(sessionId);
    const preview = await session.devices(sessionId);
    assert.deepEqual(preview.map((device: { reason: string }) => device.reason), ['UNSUPPORTED_MODEL', 'MISSING_TOKEN', 'MISSING_IP']);
    for (const did of ['unsupported', 'no-token', 'ipv6']) {
      assert.throws(() => session.select(sessionId, [did]), { code: 'INVALID_SELECTION' });
    }
  } finally { session.reset(); }
});

test('sessions expire, clear account state, and reject unsupported regions', async () => {
  const { session, client, clock } = setup();
  try {
    await assert.rejects(session.start('unknown'), { code: 'INVALID_REGION' });
    const { sessionId } = await session.start('de');
    clock.value = 15 * 60 * 1000;
    await assert.rejects(session.poll(sessionId), { code: 'SESSION_EXPIRED' });
    assert.equal(client.resets, 1);
  } finally { session.reset(); }
});

test('a late response from a canceled login cannot restore its session', async () => {
  let resolveLogin: (value: object) => void = () => {};
  const client = {
    startQrLogin: () => new Promise((resolve) => { resolveLogin = resolve; }),
    reset() {},
  };
  const session = new CloudSession({ createClient: () => client, regions: ['de'], isSupportedModel: () => true });
  const starting = session.start('de');
  session.reset();
  resolveLogin({ qrImageUrl: 'https://account.xiaomi.com/qr', loginUrl: 'https://account.xiaomi.com/login', expiresAt: 100 });
  await assert.rejects(starting, { code: 'SESSION_EXPIRED' });
});

test('cloud import preserves Homebridge settings, manual identity, names and disabled state', () => {
  const original = [
    { platform: 'OtherPlatform', untouched: true },
    { platform: 'XiaomiMiot', name: 'Home', pollInterval: 30, _bridge: { username: 'AA:BB:CC:DD:EE:FF' }, devices: [
      { id: 'salon', name: 'Salon', model: 'xiaomi.airp.cpa4', host: DEVICE.localip, token: 'old-token', enabled: false, exposeDisplay: true },
    ] },
  ];
  const incoming = { did: DEVICE.did, name: DEVICE.name, model: DEVICE.model, host: DEVICE.localip, token: TOKEN, enabled: true };
  const merged = mergeDevices(original, [incoming]);
  assert.deepEqual(merged[0], original[0]);
  assert.deepEqual(merged[1]._bridge, { username: 'AA:BB:CC:DD:EE:FF' });
  assert.equal(merged[1].pollInterval, 30);
  assert.equal(merged[1].devices.length, 1);
  assert.equal(merged[1].devices[0].id, 'salon');
  assert.equal(merged[1].devices[0].name, 'Salon');
  assert.equal(merged[1].devices[0].enabled, false);
  assert.equal(merged[1].devices[0].exposeDisplay, true);
  assert.equal(merged[1].devices[0].token, TOKEN);
  assert.equal(original[1]?.devices?.[0]?.token, 'old-token');
  const moved = mergeDevices(merged, [{ ...incoming, host: '192.168.1.51' }]);
  assert.equal(moved[1].devices.length, 1);
  assert.equal(moved[1].devices[0].host, '192.168.1.51');
});


test('cloud onboarding imports an E10 alongside the purifier using the shared device registry', async () => {
  const vacuum = { ...DEVICE, did: 'robot', name: 'Robot', model: 'xiaomi.vacuum.b112', localip: '192.168.1.51' };
  const { session } = setup([DEVICE, vacuum]);
  try {
    const { sessionId } = await session.start('de');
    await session.poll(sessionId);
    const preview = await session.devices(sessionId);
    assert.deepEqual(preview.map((item: { canImport: boolean }) => item.canImport), [true, true]);
    assert.ok(!JSON.stringify(preview).includes(TOKEN));
    const selected = session.select(sessionId, [DEVICE.did, vacuum.did]);
    assert.deepEqual(selected.map((item: { model: string }) => item.model), [DEVICE.model, vacuum.model]);
  } finally { session.reset(); }
});
