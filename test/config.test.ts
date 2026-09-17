import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceIdentity, parseConfig } from '../src/config.js';

const device = { name: 'Living room', model: 'zhimi.airp.cpa4', host: '192.168.1.30', token: '00112233445566778899aabbccddeeff' };
test('validates manual config and defaults', () => {
  assert.deepEqual(parseConfig({ devices: [device] }), { devices: [device], pollInterval: 15 });
  assert.deepEqual(parseConfig({ devices: [{ ...device, id: '', did: ' ' }] }).devices, [device]);
  assert.deepEqual(parseConfig({}), { devices: [], pollInterval: 15 });
  assert.equal(parseConfig({ devices: [{ ...device, model: 'xiaomi.airp.cpa4' }] }).devices.length, 1);
  assert.equal(parseConfig({ devices: [{ ...device, model: 'xiaomi.vacuum.b112' }] }).devices.length, 1);
});
test('rejects invalid secrets, addresses, intervals, identity collisions and unsupported devices', () => {
  for (const change of [{ token: 'secret' }, { host: 'http://192.168.1.30' }, { model: 'unknown' }, { name: '' }, { id: 123 }, { enabled: 'yes' }]) {
    assert.throws(() => parseConfig({ devices: [{ ...device, ...change }] }));
  }
  for (const pollInterval of [0, NaN, 301, '15']) assert.throws(() => parseConfig({ pollInterval }));
  assert.throws(() => parseConfig({ devices: [device, device] }), /more than once/);
  assert.throws(() => parseConfig({ devices: [{ ...device, did: 'a' }, { ...device, host: '192.168.1.31', did: 'a' }] }), /more than once/);
  assert.throws(() => parseConfig({ devices: [{ ...device, did: 'a', id: 'first' }, { ...device, host: '192.168.1.31', did: 'a', id: 'second' }] }), /more than once/);
  assert.throws(() => parseConfig({ devices: { token: device.token } }), /list/);
  try { parseConfig({ devices: [{ ...device, token: 'supersecret' }] }); } catch (error) { assert.ok(!String(error).includes('supersecret')); }
});
test('disabled entries can be kept incomplete and stable IDs survive IP or token rotation', () => {
  assert.deepEqual(parseConfig({ devices: [{ enabled: false }] }).devices, []);
  assert.equal(deviceIdentity({ ...device, id: 'office' }), deviceIdentity({ ...device, id: 'office', host: '192.168.1.31' }));
  assert.equal(deviceIdentity({ ...device, did: '123' }), 'did:123');
  assert.equal(deviceIdentity(device), 'host:192.168.1.30');
});


test('display control is opt-in, type-checked and limited to supported purifiers', () => {
  assert.equal(parseConfig({ devices: [device] }).devices[0]?.exposeDisplay, undefined);
  assert.equal(parseConfig({ devices: [{ ...device, exposeDisplay: true }] }).devices[0]?.exposeDisplay, true);
  assert.equal(parseConfig({ devices: [{ ...device, exposeDisplay: false }] }).devices[0]?.exposeDisplay, false);
  assert.throws(() => parseConfig({ devices: [{ ...device, exposeDisplay: 'true' }] }), /exposeDisplay/);
  assert.throws(() => parseConfig({ devices: [{ ...device, model: 'xiaomi.vacuum.b112', exposeDisplay: true }] }), /only for air purifiers/);
});
