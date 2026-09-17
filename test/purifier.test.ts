import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as hap from '@homebridge/hap-nodejs';
import type { API, Logger, PlatformAccessory } from 'homebridge';
import type { DeviceConfig } from '../src/config.js';
import type { MiotTransport } from '../src/miio/transport.js';
import { PurifierDevice } from '../src/devices/purifier.js';
import { airQualityFromPm25, favoriteLevelFromPercent, getPurifierProfile, isSupportedModel, percentFromFavoriteLevel } from '../src/devices/profiles.js';
import { PurifierAccessory } from '../src/homekit/purifier-accessory.js';

interface RequestProperty { did: string; siid: number; piid: number; value?: unknown }

class DeviceEmulator implements MiotTransport {
  readonly calls: Array<{ method: string; params: RequestProperty[] }> = [];
  readonly values = new Map<string, unknown>([
    ['2/1', true], ['2/2', 0], ['2/4', 0], ['3/4', 18],
    ['4/1', 81], ['8/1', false], ['9/11', 5], ['9/1', 600], ['13/2', 2],
  ]);
  closed = false;
  ignoreWrites = false;
  rejectWrites = false;
  offline = false;
  malformed = false;
  inFlight = 0;
  maxInFlight = 0;

  async request(method: string, params: unknown[]): Promise<unknown> {
    assert.equal(this.closed, false, 'No protocol call after close');
    assert.equal(params.length, 1, 'CPA4 requests must never batch properties');
    const entries = params as RequestProperty[];
    this.calls.push({ method, params: entries });
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    try {
      await Promise.resolve();
      if (this.offline) { throw new Error('Device request timed out'); }
      const item = entries[0]!;
      const key = `${item.siid}/${item.piid}`;
      if (method === 'set_properties') {
        if (!this.rejectWrites && !this.ignoreWrites) { this.values.set(key, item.value); }
        return [{ ...item, code: this.rejectWrites ? -4004 : 0 }];
      }
      assert.equal(method, 'get_properties');
      if (this.malformed) { return [{ siid: 99, piid: 99, code: 0, value: 1 }]; }
      return [{ ...item, code: 0, value: this.values.get(key) }];
    } finally {
      --this.inFlight;
    }
  }
  close(): void { this.closed = true; }
  writes(): RequestProperty[] { return this.calls.filter(c => c.method === 'set_properties').flatMap(c => c.params); }
}

function fixture(model = 'xiaomi.airp.cpa4', exposeDisplay = false) {
  const emulator = new DeviceEmulator();
  const accessory = new hap.Accessory('Purifier', hap.uuid.generate(`purifier-${model}`));
  const warnings: string[] = [];
  const logs: string[] = [];
  const logger = {
    warn: (message: string) => { warnings.push(message); },
    info: (message: string) => { logs.push(message); },
    debug: () => {}, error: () => {}, success: () => {},
  } as unknown as Logger;
  const config: DeviceConfig = { name: 'Purifier', model, host: '192.0.2.10', token: '0'.repeat(32), did: '12345678', exposeDisplay };
  const controller = new PurifierAccessory({ hap } as unknown as API, logger, accessory as unknown as PlatformAccessory, config, emulator, 15);
  const purifier = accessory.getService(hap.Service.AirPurifier)!;
  const air = accessory.getService(hap.Service.AirQualitySensor)!;
  const filter = accessory.getService(hap.Service.FilterMaintenance)!;
  return { emulator, accessory, controller, purifier, air, filter, warnings, logs, config, logger };
}

async function communicationFailure(result: Promise<unknown>): Promise<void> {
  await assert.rejects(result, (error: unknown) => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
}

test('model profiles match the two official CPA4 MIoT instances', () => {
  assert.equal(isSupportedModel('xiaomi.airp.cpa4'), true);
  assert.equal(isSupportedModel('zhimi.airp.cpa4'), true);
  assert.equal(isSupportedModel('zhimi.airp.cpa4a'), false);
  assert.throws(() => getPurifierProfile('xiaomi.unknown'));
  for (const model of ['xiaomi.airp.cpa4', 'zhimi.airp.cpa4']) {
    const profile = getPurifierProfile(model);
    assert.deepEqual([profile.properties.favoriteLevel.siid, profile.properties.favoriteLevel.piid], [9, 11]);
    assert.deepEqual([profile.properties.pm25.siid, profile.properties.pm25.piid], [3, 4]);
    assert.equal(profile.properties.favoriteLevel.max, 14);
  }
});

test('every favorite level is reachable while zero percent remains reserved for off', () => {
  for (let level = 0; level < 15; level++) {
    const percent = percentFromFavoriteLevel(level);
    assert.ok(percent >= 2 && percent <= 100);
    assert.equal(favoriteLevelFromPercent(percent), level);
  }
  assert.throws(() => favoriteLevelFromPercent(NaN));
  assert.throws(() => favoriteLevelFromPercent(0));
  assert.equal(airQualityFromPm25(NaN), 0);
});

test('polls are coalesced and protocol requests serialized across reads and writes', async () => {
  const emulator = new DeviceEmulator();
  const device = new PurifierDevice(emulator, getPurifierProfile('xiaomi.airp.cpa4'));
  const first = device.refresh();
  assert.equal(device.refresh(), first);
  const change = device.setPower(false);
  await Promise.all([first, change]);
  assert.equal(emulator.maxInFlight, 1);
  assert.equal(emulator.calls.slice(0, 8).every(c => c.method === 'get_properties'), true);
  assert.equal(emulator.calls[8]!.method, 'set_properties');
  assert.equal(device.state?.power, false);
  device.close();
});

test('speed writes use the correct favorite property, select Manual and verify readback', async () => {
  const emulator = new DeviceEmulator();
  const device = new PurifierDevice(emulator, getPurifierProfile('zhimi.airp.cpa4'), '123');
  await device.setSpeed(100);
  assert.deepEqual(emulator.writes().map(({ siid, piid, value }) => ({ siid, piid, value })), [
    { siid: 9, piid: 11, value: 14 }, { siid: 2, piid: 4, value: 2 }, { siid: 2, piid: 1, value: true },
  ]);
  assert.equal(device.state?.favoriteLevel, 14);
  assert.equal(device.state?.mode, 2);
  assert.equal(emulator.calls.every(c => c.params[0]!.did === '123'), true);
  await device.setSpeed(0);
  assert.deepEqual(emulator.writes().at(-1), { did: '123', siid: 2, piid: 1, value: false });
  assert.equal(device.state?.mode, 2);
  await assert.rejects(device.setSpeed(Infinity));
  device.close();
});

test('rejected writes and un-applied acknowledgements do not become successful state', async () => {
  const emulator = new DeviceEmulator();
  const device = new PurifierDevice(emulator, getPurifierProfile('xiaomi.airp.cpa4'));
  await device.refresh();
  emulator.rejectWrites = true;
  await assert.rejects(device.setPower(false), /code -4004/);
  assert.equal(device.state, undefined);
  emulator.rejectWrites = false;
  emulator.ignoreWrites = true;
  await assert.rejects(device.setPower(false), /did not apply/);
  assert.equal(device.state, undefined);
  emulator.ignoreWrites = false;
  const recovered = await device.setPower(false);
  assert.equal(recovered.power, false, 'queue recovers after rejected operations');
  device.close();
});

test('malformed responses and out-of-range readings fail without publishing invented values', async () => {
  const emulator = new DeviceEmulator();
  const device = new PurifierDevice(emulator, getPurifierProfile('xiaomi.airp.cpa4'));
  emulator.malformed = true;
  await assert.rejects(device.refresh(), /Mismatched/);
  assert.equal(device.state, undefined);
  emulator.malformed = false;
  emulator.values.set('3/4', -20);
  await assert.rejects(device.refresh(), /Invalid MIoT value/);
  assert.equal(device.state, undefined);
  emulator.values.set('3/4', 25);
  const recovered = await device.refresh();
  assert.equal(recovered.pm25, 25);
  device.close();
});

test('real HAP services remain native and expose no fabricated state before the first poll', async () => {
  const f = fixture();
  const C = hap.Characteristic;
  assert.deepEqual(f.accessory.services.map(s => s.UUID).sort(), [
    hap.Service.AccessoryInformation.UUID, hap.Service.AirPurifier.UUID,
    hap.Service.AirQualitySensor.UUID, hap.Service.FilterMaintenance.UUID,
  ].sort());
  assert.equal(f.purifier.isPrimaryService, true);
  assert.ok(f.purifier.linkedServices.includes(f.air));
  assert.ok(f.purifier.linkedServices.includes(f.filter));
  assert.equal(f.purifier.testCharacteristic(C.StatusFault), false);
  assert.equal(f.purifier.testCharacteristic(C.FilterLifeLevel), false);
  assert.equal(f.filter.testCharacteristic(C.ResetFilterIndication), false);
  await communicationFailure(f.purifier.getCharacteristic(C.Active).handleGetRequest());
  await communicationFailure(f.filter.getCharacteristic(C.FilterLifeLevel).handleGetRequest());
  await f.controller.refresh();
  assert.equal(await f.purifier.getCharacteristic(C.Active).handleGetRequest(), C.Active.ACTIVE);
  assert.equal(await f.air.getCharacteristic(C.PM2_5Density).handleGetRequest(), 18);
  assert.equal(await f.filter.getCharacteristic(C.FilterLifeLevel).handleGetRequest(), 81);
  f.controller.stop();
});

test('native characteristics control power, auto/manual and physical child lock', async () => {
  const f = fixture();
  const C = hap.Characteristic;
  await f.controller.refresh();
  await f.purifier.getCharacteristic(C.LockPhysicalControls).handleSetRequest(C.LockPhysicalControls.CONTROL_LOCK_ENABLED);
  assert.equal(f.emulator.values.get('8/1'), true);
  await f.purifier.getCharacteristic(C.TargetAirPurifierState).handleSetRequest(C.TargetAirPurifierState.MANUAL);
  assert.equal(f.emulator.values.get('2/4'), 2);
  await f.purifier.getCharacteristic(C.TargetAirPurifierState).handleSetRequest(C.TargetAirPurifierState.AUTO);
  assert.equal(f.emulator.values.get('2/4'), 0);
  await f.purifier.getCharacteristic(C.Active).handleSetRequest(C.Active.INACTIVE);
  assert.equal(f.emulator.values.get('2/1'), false);
  assert.equal(await f.purifier.getCharacteristic(C.CurrentAirPurifierState).handleGetRequest(), C.CurrentAirPurifierState.INACTIVE);
  f.controller.stop();
});

test('Sleep selected outside HomeKit maps to Manual without an extra switch', async () => {
  const f = fixture();
  f.emulator.values.set('2/4', 1);
  await f.controller.refresh();
  assert.equal(await f.purifier.getCharacteristic(hap.Characteristic.TargetAirPurifierState).handleGetRequest(), 0);
  assert.equal(await f.purifier.getCharacteristic(hap.Characteristic.RotationSpeed).handleGetRequest(), 1);
  assert.equal(f.emulator.writes().length, 0, 'polling must never change device mode');
  f.controller.stop();
});

test('sensor and motor faults report native fault state and transition-only diagnostics', async () => {
  const f = fixture();
  const C = hap.Characteristic;
  f.emulator.values.set('2/2', 3);
  await f.controller.refresh();
  await f.controller.refresh();
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0]!, /Particulate sensor unavailable.*MIoT 3/);
  assert.equal(await f.air.getCharacteristic(C.AirQuality).handleGetRequest(), C.AirQuality.UNKNOWN);
  assert.equal(await f.air.getCharacteristic(C.StatusFault).handleGetRequest(), C.StatusFault.GENERAL_FAULT);
  await communicationFailure(f.air.getCharacteristic(C.PM2_5Density).handleGetRequest());
  f.emulator.values.set('2/2', 2);
  await f.controller.refresh();
  assert.equal(await f.purifier.getCharacteristic(C.CurrentAirPurifierState).handleGetRequest(), C.CurrentAirPurifierState.IDLE);
  f.emulator.values.set('2/2', 0);
  await f.controller.refresh();
  assert.equal(f.logs.filter(x => x.includes('fault cleared')).length, 1);
  f.controller.stop();
});

test('filter exhaustion is linked to standard filter maintenance and only logs on change', async () => {
  const f = fixture();
  f.emulator.values.set('4/1', 0);
  await f.controller.refresh();
  await f.controller.refresh();
  assert.equal(await f.filter.getCharacteristic(hap.Characteristic.FilterChangeIndication).handleGetRequest(), 1);
  assert.equal(f.warnings.filter(x => x.includes('filter life')).length, 1);
  f.controller.stop();
});

test('offline reads and writes fail with HAP status and the accessory recovers after polling', async () => {
  const f = fixture();
  const active = f.purifier.getCharacteristic(hap.Characteristic.Active);
  await f.controller.refresh();
  f.emulator.offline = true;
  await f.controller.refresh();
  await communicationFailure(active.handleGetRequest());
  await communicationFailure(active.handleSetRequest(0));
  f.emulator.offline = false;
  await f.controller.refresh();
  assert.equal(await active.handleGetRequest(), 1);
  assert.equal(f.logs.filter(x => x.includes('communication restored')).length, 1);
  f.controller.stop();
});

test('start is idempotent, and stop closes the transport and blocks future requests', async () => {
  const f = fixture();
  f.controller.start();
  f.controller.start();
  await f.controller.refresh();
  assert.equal(f.emulator.calls.length, 8);
  f.controller.stop();
  const count = f.emulator.calls.length;
  f.controller.start();
  await f.controller.refresh();
  await communicationFailure(f.purifier.getCharacteristic(hap.Characteristic.Active).handleGetRequest());
  await communicationFailure(f.purifier.getCharacteristic(hap.Characteristic.Active).handleSetRequest(1));
  assert.equal(f.emulator.calls.length, count);
  assert.equal(f.emulator.closed, true);
});


test('native speed selects real Sleep at 1% and preserves it when Manual is repeated', async () => {
  const f = fixture();
  const C = hap.Characteristic;
  try {
    await f.controller.refresh();
    const previousFavorite = f.emulator.values.get('9/11');
    await f.purifier.getCharacteristic(C.RotationSpeed).handleSetRequest(1);
    assert.equal(f.emulator.values.get('2/4'), 1, 'Use Xiaomi Sleep, not the lowest Favorite level');
    assert.equal(f.emulator.values.get('9/11'), previousFavorite);
    assert.equal(await f.purifier.getCharacteristic(C.RotationSpeed).handleGetRequest(), 1);
    assert.equal(await f.purifier.getCharacteristic(C.TargetAirPurifierState).handleGetRequest(), C.TargetAirPurifierState.MANUAL);
    await f.purifier.getCharacteristic(C.TargetAirPurifierState).handleSetRequest(C.TargetAirPurifierState.MANUAL);
    assert.equal(f.emulator.values.get('2/4'), 1, 'HomeKit Manual includes Sleep and must not cancel it');
    await f.purifier.getCharacteristic(C.RotationSpeed).handleSetRequest(2);
    assert.equal(f.emulator.values.get('2/4'), 2);
    assert.equal(f.emulator.values.get('9/11'), 0);
    assert.equal(await f.purifier.getCharacteristic(C.RotationSpeed).handleGetRequest(), 2);
    await f.purifier.getCharacteristic(C.RotationSpeed).handleSetRequest(0);
    assert.equal(f.emulator.values.get('2/1'), false);
  } finally { f.controller.stop(); }
});


test('optional native display light controls only the backlight with confirmed discrete brightness', async () => {
  for (const model of ['xiaomi.airp.cpa4', 'zhimi.airp.cpa4']) {
    const f = fixture(model, true);
    const C = hap.Characteristic;
    try {
      const display = f.accessory.getServiceById(hap.Service.Lightbulb, 'display')!;
      assert.ok(display);
      assert.ok(f.purifier.linkedServices.includes(display));
      assert.equal(f.purifier.isPrimaryService, true);
      await communicationFailure(display.getCharacteristic(C.Brightness).handleGetRequest());
      await f.controller.refresh();
      assert.equal(await display.getCharacteristic(C.Brightness).handleGetRequest(), 100);
      const brightness = display.getCharacteristic(C.Brightness);
      assert.equal(await brightness.handleSetRequest(25), 50, 'Write response returns the actual discrete setting');
      assert.equal(brightness.value, 50);
      assert.equal(f.emulator.values.get('13/2'), 1);
      await display.getCharacteristic(C.On).handleSetRequest(false);
      assert.equal(f.emulator.values.get('13/2'), 0);
      assert.equal(await brightness.handleGetRequest(), 0);
      await display.getCharacteristic(C.On).handleSetRequest(true);
      assert.equal(f.emulator.values.get('13/2'), 1, 'Turning on restores the previous dim setting');
      await brightness.handleSetRequest(90);
      assert.equal(brightness.value, 100);
      assert.equal(f.emulator.values.get('13/2'), 2);
      await brightness.handleSetRequest(0);
      assert.equal(await display.getCharacteristic(C.On).handleGetRequest(), false);
      assert.equal(f.emulator.values.get('2/1'), true, 'Display off does not turn off purification');
      assert.equal(f.emulator.values.get('2/4'), 0);
      assert.equal(f.emulator.values.get('9/11'), 5);
      assert.ok(f.emulator.writes().every(p => p.siid === 13 && p.piid === 2));
      f.emulator.values.set('13/2', 1);
      await f.controller.refresh();
      assert.equal(brightness.value, 50, 'External display changes are reflected by polling');
      f.emulator.ignoreWrites = true;
      await communicationFailure(brightness.handleSetRequest(100));
      await communicationFailure(brightness.handleGetRequest());
      f.emulator.ignoreWrites = false;
      await f.controller.refresh();
      assert.equal(await brightness.handleGetRequest(), 50);
    } finally { f.controller.stop(); }
  }
});

test('turning on the display never powers on an inactive purifier', async () => {
  const f = fixture('xiaomi.airp.cpa4', true);
  try {
    f.emulator.values.set('2/1', false);
    f.emulator.values.set('13/2', 0);
    await f.controller.refresh();
    const display = f.accessory.getServiceById(hap.Service.Lightbulb, 'display')!;
    await display.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
    assert.equal(f.emulator.values.get('2/1'), false);
    assert.equal(f.emulator.values.get('13/2'), 2);
    assert.ok(f.emulator.writes().every(p => p.siid === 13 && p.piid === 2));
  } finally { f.controller.stop(); }
});

test('disabling display control removes only its cached service and stops polling its property', async () => {
  const f = fixture('xiaomi.airp.cpa4', true);
  const uuid = f.accessory.UUID;
  const display = f.accessory.getServiceById(hap.Service.Lightbulb, 'display')!;
  f.controller.stop();
  const emulator = new DeviceEmulator();
  const controller = new PurifierAccessory({ hap } as unknown as API, f.logger, f.accessory as unknown as PlatformAccessory,
    { ...f.config, exposeDisplay: false }, emulator, 15);
  try {
    assert.equal(f.accessory.UUID, uuid);
    assert.equal(f.accessory.getService(hap.Service.AirPurifier), f.purifier);
    assert.equal(f.accessory.getServiceById(hap.Service.Lightbulb, 'display'), undefined);
    assert.ok(!f.purifier.linkedServices.includes(display));
    await controller.refresh();
    assert.ok(emulator.calls.every(c => c.params[0]!.siid !== 13));
  } finally { controller.stop(); }
});
