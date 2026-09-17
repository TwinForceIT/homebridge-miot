import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PurifierDevice } from '../src/devices/purifier.js';
import { favoriteLevelFromPercent, getPurifierProfile, percentFromFavoriteLevel } from '../src/devices/profiles.js';
import type { MiotParams, MiotTransport } from '../src/miio/transport.js';

interface PropertyRequest { did: string; siid: number; piid: number; value?: unknown }

class ControlEmulator implements MiotTransport {
  readonly calls: Array<{ method: string; property: PropertyRequest }> = [];
  readonly values = new Map<string, unknown>([
    ['2/1', false], ['2/2', 0], ['2/4', 0], ['3/4', 18],
    ['4/1', 81], ['8/1', false], ['9/11', 7], ['9/1', 600], ['13/2', 2],
  ]);
  ignoreWrites = false;
  maxInFlight = 0;
  private inFlight = 0;
  private closed = false;

  async request(method: string, params: MiotParams): Promise<unknown> {
    assert.equal(this.closed, false);
    assert.ok(Array.isArray(params));
    assert.equal(params.length, 1, 'CPA4 firmware requires one property per request');
    const property = params[0] as PropertyRequest;
    this.calls.push({ method, property });
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    try {
      await Promise.resolve();
      const key = `${property.siid}/${property.piid}`;
      if (method === 'set_properties') {
        if (!this.ignoreWrites) { this.values.set(key, property.value); }
        return [{ ...property, code: 0 }];
      }
      assert.equal(method, 'get_properties');
      return [{ ...property, code: 0, value: this.values.get(key) }];
    } finally {
      --this.inFlight;
    }
  }

  close(): void { this.closed = true; }

  writes() {
    return this.calls.filter(call => call.method === 'set_properties')
      .map(({ property }) => ({ address: `${property.siid}/${property.piid}`, value: property.value }));
  }
}

function fixture(display = false, model = 'xiaomi.airp.cpa4') {
  const emulator = new ControlEmulator();
  const device = new PurifierDevice(emulator, getPurifierProfile(model), '123', { display });
  return { emulator, device };
}

test('Sleep uses the actual Xiaomi mode and preserves the chosen manual fan level', async () => {
  for (const model of ['xiaomi.airp.cpa4', 'zhimi.airp.cpa4']) {
    const { emulator, device } = fixture(false, model);
    const asleep = await device.setSpeed(1);
    assert.equal(asleep.mode, 1);
    assert.equal(asleep.power, true);
    assert.equal(asleep.favoriteLevel, 7);
    assert.deepEqual(emulator.writes(), [
      { address: '2/4', value: 1 }, { address: '2/1', value: true },
    ]);
    assert.equal(emulator.calls.every(call => call.property.did === '123'), true);
    const off = await device.setSpeed(0);
    assert.equal(off.power, false);
    assert.equal(off.mode, 1, 'off must not replace the selected Xiaomi mode');
    device.close();
  }
});

test('a repeated HAP Manual command preserves freshly read Sleep, even when queued after a speed change', async () => {
  const { emulator, device } = fixture();
  await device.refresh();
  emulator.values.set('2/4', 1); // A physical button changed mode after the last poll.
  const manual = await device.setMode(false);
  assert.equal(manual.mode, 1);
  assert.deepEqual(emulator.writes(), []);
  await device.setMode(true);
  assert.equal(device.state?.mode, 0);
  emulator.calls.length = 0;
  const [, repeated] = await Promise.all([device.setSpeed(1), device.setMode(false)]);
  assert.equal(repeated.mode, 1);
  assert.deepEqual(emulator.writes(), [
    { address: '2/4', value: 1 }, { address: '2/1', value: true },
  ]);
  assert.equal(emulator.maxInFlight, 1);
  device.close();
});

test('all fifteen manual levels remain selectable above the reserved Sleep position', async () => {
  const { device } = fixture();
  for (let level = 0; level < 15; level++) {
    const percent = percentFromFavoriteLevel(level);
    assert.ok(percent >= 2 && percent <= 100);
    assert.equal(favoriteLevelFromPercent(percent), level);
    const state = await device.setSpeed(percent);
    assert.equal(state.mode, 2);
    assert.equal(state.favoriteLevel, level);
    assert.equal(state.power, true);
  }
  assert.throws(() => favoriteLevelFromPercent(1));
  device.close();
});

test('display is opt-in and disabled polling never requests the screen property', async () => {
  const { emulator, device } = fixture();
  emulator.values.delete('13/2');
  const state = await device.refresh();
  assert.equal(state.displayBrightness, undefined);
  assert.equal(emulator.calls.length, 8);
  assert.equal(emulator.calls.some(call => call.property.siid === 13), false);
  await assert.rejects(device.setDisplayBrightness(50), /disabled/);
  await assert.rejects(device.setDisplayPower(true), /disabled/);
  assert.equal(device.state, state, 'unsupported controls must not invalidate valid purifier readings');
  device.close();
});

test('screen levels use the official MIoT property and never change purifier power or mode', async () => {
  for (const model of ['xiaomi.airp.cpa4', 'zhimi.airp.cpa4']) {
    const { emulator, device } = fixture(true, model);
    assert.deepEqual(getPurifierProfile(model).properties.displayBrightness, {
      siid: 13, piid: 2, format: 'integer', min: 0, max: 2, writable: true,
    });
    for (const [percent, level] of [[0, 0], [50, 1], [100, 2]] as const) {
      const state = await device.setDisplayBrightness(percent);
      assert.equal(state.displayBrightness, level);
      assert.equal(state.power, false);
      assert.equal(state.mode, 0);
      assert.equal(state.favoriteLevel, 7);
    }
    assert.deepEqual(emulator.writes(), [
      { address: '13/2', value: 0 }, { address: '13/2', value: 1 }, { address: '13/2', value: 2 },
    ]);
    device.close();
  }
});

test('screen power restores the last actual nonzero level and preserves a dim screen already on', async () => {
  const { emulator, device } = fixture(true);
  emulator.values.set('13/2', 1); // Changed with the physical display button before any poll.
  await device.setDisplayPower(true);
  assert.deepEqual(emulator.writes(), [], 'repeated On must not brighten an already dim screen');
  assert.equal((await device.setDisplayPower(false)).displayBrightness, 0);
  assert.equal((await device.setDisplayPower(true)).displayBrightness, 1);
  assert.equal((await device.setDisplayBrightness(0)).displayBrightness, 0);
  assert.equal((await device.setDisplayPower(true)).displayBrightness, 1);
  assert.equal(emulator.writes().every(write => write.address === '13/2'), true);
  device.close();
});

test('screen commands and purifier commands share a queue without losing their independent state', async () => {
  const { emulator, device } = fixture(true);
  await Promise.all([device.setSpeed(1), device.setDisplayBrightness(50), device.setDisplayPower(true)]);
  assert.equal(emulator.maxInFlight, 1);
  assert.equal(device.state?.mode, 1);
  assert.equal(device.state?.power, true);
  assert.equal(device.state?.displayBrightness, 1);
  assert.deepEqual(emulator.writes(), [
    { address: '2/4', value: 1 }, { address: '2/1', value: true }, { address: '13/2', value: 1 },
  ]);
  device.close();
});

test('screen writes require actual readback and reject invalid values without inventing state', async () => {
  const { emulator, device } = fixture(true);
  await device.refresh();
  const initial = device.state;
  for (const invalid of [NaN, Infinity, -1, 101]) {
    await assert.rejects(device.setDisplayBrightness(invalid), /between 0 and 100/);
  }
  assert.equal(device.state, initial);
  emulator.ignoreWrites = true;
  await assert.rejects(device.setDisplayBrightness(50), /did not apply MIoT property 13\/2/);
  assert.equal(device.state, undefined);
  emulator.ignoreWrites = false;
  assert.equal((await device.setDisplayBrightness(50)).displayBrightness, 1);
  emulator.values.set('13/2', 3);
  await assert.rejects(device.refresh(), /Invalid MIoT value for 13\/2/);
  assert.equal(device.state, undefined);
  device.close();
});
