import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MiotTransport, MiotParams } from '../src/miio/transport.js';
import { getVacuumProfile, SUPPORTED_VACUUM_MODELS } from '../src/devices/vacuum-profile.js';
import { VacuumDevice, VacuumStateError } from '../src/devices/vacuum.js';

interface RequestProperty { did: string; siid: number; piid: number; value?: unknown }
interface RequestAction { did: string; siid: number; aiid: number; in: unknown[] }

/** A stateful protocol peer: readings change only after the firmware applies a command. */
class VacuumEmulator implements MiotTransport {
  readonly calls: Array<{ method: string; params: MiotParams }> = [];
  readonly values = new Map<string, unknown>([
    ['2/1', 4], ['2/2', 0], ['2/4', 1], ['3/1', 79],
    ['7/5', 2], ['7/6', 2], ['7/12', 87], ['7/10', 82], ['7/8', 73], ['7/14', 65],
  ]);
  closed = false;
  offline = false;
  ignoreWrites = false;
  delayedAction = false;
  rejectCode = 0;
  actionReply?: unknown;
  malformedProperty = false;
  inFlight = 0;
  maxInFlight = 0;

  async request(method: string, params: MiotParams): Promise<unknown> {
    assert.equal(this.closed, false, 'No protocol call after close');
    this.calls.push({ method, params });
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    try {
      await Promise.resolve();
      if (this.offline) { throw new Error('Device request timed out'); }
      if (method === 'action') {
        assert.equal(Array.isArray(params), false, 'MIoT action params are an object, not an array');
        const action = params as unknown as RequestAction;
        assert.deepEqual(action.in, [], 'E10 standard actions have no input properties');
        if (this.actionReply !== undefined) { return this.actionReply; }
        if (!this.delayedAction && this.rejectCode === 0) {
          const key = `${action.siid}/${action.aiid}`;
          if (key === '2/1') { this.values.set('2/1', 5 + Number(this.values.get('2/4'))); }
          else if (key === '2/2') { this.values.set('2/1', 2); }
          else if (key === '3/1') { this.values.set('2/1', 3); }
          else { assert.fail(`Unknown action ${key}`); }
        }
        return { did: action.did, siid: action.siid, aiid: action.aiid, code: this.rejectCode, out: [] };
      }
      assert.ok(Array.isArray(params));
      assert.equal(params.length, 1);
      const entry = params[0] as RequestProperty;
      const key = `${entry.siid}/${entry.piid}`;
      if (method === 'set_properties') {
        if (!this.ignoreWrites && this.rejectCode === 0 && key !== '4/1') { this.values.set(key, entry.value); }
        return [{ did: entry.did, siid: entry.siid, piid: entry.piid, code: this.rejectCode }];
      }
      assert.equal(method, 'get_properties');
      if (this.malformedProperty) { return [{ siid: 100, piid: 100, code: 0, value: 1 }]; }
      return [{ ...entry, code: 0, value: this.values.get(key) }];
    } finally {
      --this.inFlight;
    }
  }

  close(): void { this.closed = true; }
  actions(): RequestAction[] {
    return this.calls.filter(call => call.method === 'action').map(call => call.params as unknown as RequestAction);
  }
  writes(): RequestProperty[] {
    return this.calls.filter(call => call.method === 'set_properties').flatMap(call => call.params as RequestProperty[]);
  }
}

function fixture(did?: string) {
  const emulator = new VacuumEmulator();
  const device = new VacuumDevice(emulator, getVacuumProfile('xiaomi.vacuum.b112'), did);
  return { emulator, device };
}

test('E10 profile stays model-specific and follows the official vacuum and battery services', () => {
  assert.deepEqual(SUPPORTED_VACUUM_MODELS, ['xiaomi.vacuum.b112']);
  assert.throws(() => getVacuumProfile('xiaomi.vacuum.b112bk'), /Unsupported/);
  assert.throws(() => getVacuumProfile('xiaomi.vacuum.b112gl'), /Unsupported/);
  const profile = getVacuumProfile('xiaomi.vacuum.b112');
  assert.match(profile.source, /xiaomi-b112:1$/);
  assert.deepEqual(profile.actions, { start: { siid: 2, aiid: 1 }, stop: { siid: 2, aiid: 2 }, dock: { siid: 3, aiid: 1 } });
  assert.equal(profile.properties.battery.siid, 3);
  assert.equal(profile.properties.filterLife.piid, 12);
  assert.equal(profile.properties.fault.max, 3000);
  assert.equal(profile.statuses[8], 'Updating firmware');
});

test('polling reads battery, current cleaning mode and separate consumables without fabricated state', async () => {
  const { emulator, device } = fixture('123456');
  assert.equal(device.state, undefined);
  const state = await device.refresh();
  assert.deepEqual({ ...state, sampledAt: 0 }, {
    status: 4, fault: 0, mode: 1, battery: 79, suction: 2, water: 2,
    filterLife: 87, mainBrushLife: 82, sideBrushLife: 73, mopLife: 65, sampledAt: 0,
  });
  assert.ok(state.sampledAt > 0);
  assert.equal(emulator.calls.every(call => (call.params as RequestProperty[])[0]?.did === '123456'), true);
  device.close();
});

test('start, pause, resume, stop and dock send exact MIoT actions and report real firmware status', async () => {
  const { emulator, device } = fixture('123');
  assert.equal((await device.start()).status, 6);
  assert.equal((await device.pause()).status, 2);
  assert.equal((await device.resume()).status, 6);
  assert.equal((await device.stop()).status, 2, 'The firmware paused: do not invent an idle state');
  assert.equal((await device.dock()).status, 3);
  assert.deepEqual(emulator.actions(), [
    { did: '123', siid: 2, aiid: 1, in: [] },
    { did: '123', siid: 2, aiid: 2, in: [] },
    { did: '123', siid: 2, aiid: 1, in: [] },
    { did: '123', siid: 2, aiid: 2, in: [] },
    { did: '123', siid: 3, aiid: 1, in: [] },
  ]);
  device.close();
});

test('an action acknowledgement never becomes invented movement state', async () => {
  const { emulator, device } = fixture();
  emulator.delayedAction = true;
  assert.equal((await device.start()).status, 4, 'Robot still reports charging after the command');
  assert.equal(device.state?.status, 4);
  assert.equal(emulator.actions()[0]?.did, '2.1');
  emulator.values.set('2/1', 6);
  assert.equal((await device.refresh()).status, 6);
  device.close();
});

test('mode, suction and water writes verify actual readback; identify is momentary', async () => {
  const { emulator, device } = fixture();
  assert.equal((await device.setMode(2)).mode, 2);
  assert.equal((await device.setSuction(4)).suction, 4);
  assert.equal((await device.setWater(0)).water, 0);
  await device.identify();
  assert.deepEqual(emulator.writes().map(({ siid, piid, value }) => ({ siid, piid, value })), [
    { siid: 2, piid: 4, value: 2 }, { siid: 7, piid: 5, value: 4 },
    { siid: 7, piid: 6, value: 0 }, { siid: 4, piid: 1, value: 1 },
  ]);
  const calls = emulator.calls.length;
  await assert.rejects(device.setMode(3), /Invalid MIoT value/);
  await assert.rejects(device.setSuction(1.5), /Invalid MIoT value/);
  await assert.rejects(device.setWater(Infinity), /Invalid MIoT value/);
  assert.equal(emulator.calls.length, calls, 'Reject invalid commands before touching the device');
  device.close();
});

test('unapplied and rejected properties clear state and allow recovery', async () => {
  const { emulator, device } = fixture();
  await device.refresh();
  emulator.ignoreWrites = true;
  await assert.rejects(device.setMode(2), /did not apply/);
  assert.equal(device.state, undefined);
  emulator.ignoreWrites = false;
  emulator.rejectCode = -4004;
  await assert.rejects(device.setMode(2), /code -4004/);
  assert.equal(device.state, undefined);
  emulator.rejectCode = 0;
  assert.equal((await device.setMode(2)).mode, 2);
  device.close();
});

test('malformed or failed action results are rejected without trusting acknowledgement state', async () => {
  const { emulator, device } = fixture();
  for (const response of [
    [{ siid: 2, aiid: 1, code: 0 }],
    { siid: 3, aiid: 1, code: 0 },
    { siid: 2, aiid: 1 },
    { siid: 2, aiid: 1, code: '0' },
    null,
  ]) {
    emulator.actionReply = response;
    await assert.rejects(device.start(), /Invalid MIoT action response/);
    assert.equal(device.state, undefined);
  }
  emulator.actionReply = undefined;
  emulator.rejectCode = -704040013;
  await assert.rejects(device.start(), /code -704040013/);
  emulator.rejectCode = 0;
  assert.equal((await device.start()).status, 6);
  device.close();
});

test('invalid sensor readings and offline failures invalidate state but do not poison the queue', async () => {
  const { emulator, device } = fixture();
  await device.refresh();
  emulator.malformedProperty = true;
  await assert.rejects(device.refresh(), /Mismatched/);
  assert.equal(device.state, undefined);
  emulator.malformedProperty = false;
  emulator.values.set('3/1', 101);
  await assert.rejects(device.refresh(), /Invalid MIoT value/);
  emulator.values.set('3/1', 40);
  emulator.offline = true;
  await assert.rejects(device.refresh(), /timed out/);
  assert.equal(device.state, undefined);
  emulator.offline = false;
  emulator.values.set('2/2', 2531);
  assert.equal((await device.refresh()).fault, 2531, 'Retain unknown official-range faults as numeric diagnostics');
  device.close();
});

test('coalesced polling cannot interleave an action or a multi-step property transaction', async () => {
  const { emulator, device } = fixture();
  const first = device.refresh();
  assert.equal(device.refresh(), first);
  await Promise.all([first, device.setMode(0), device.start()]);
  assert.equal(emulator.maxInFlight, 1);
  assert.equal(emulator.calls.slice(0, 10).every(call => call.method === 'get_properties'), true);
  assert.equal(emulator.calls[10]?.method, 'set_properties');
  assert.equal(emulator.calls[22]?.method, 'action');
  assert.equal(device.state?.status, 5);
  device.close();
});

test('closing blocks queued commands and invalidates cached state', async () => {
  const { emulator, device } = fixture();
  await device.refresh();
  const queued = device.start();
  const count = emulator.calls.length;
  device.close();
  await assert.rejects(queued, /closed/);
  await assert.rejects(device.refresh(), /closed/);
  assert.equal(device.state, undefined);
  assert.equal(emulator.calls.length, count);
  assert.equal(emulator.closed, true);
});


test('native cleaning presets apply mode and levels as one verified transaction', async () => {
  const { emulator, device } = fixture();
  const configured = device.configureCleaning({ mode: 1, suction: 4, water: 3 });
  await Promise.all([configured, device.start()]);
  assert.equal((await configured).suction, 4);
  assert.equal((await configured).water, 3);
  assert.deepEqual(emulator.writes().map(({ siid, piid, value }) => ({ siid, piid, value })), [
    { siid: 2, piid: 4, value: 1 }, { siid: 7, piid: 5, value: 4 }, { siid: 7, piid: 6, value: 3 },
  ]);
  const actionIndex = emulator.calls.findIndex(call => call.method === 'action');
  assert.equal(emulator.calls.slice(0, actionIndex).filter(call => call.method === 'set_properties').length, 3);
  assert.equal(device.state?.status, 6);
  device.close();
});

test('preset guard runs after queued Start and rejects without touching device settings', async () => {
  const { emulator, device } = fixture();
  await device.refresh();
  const started = device.start();
  const preset = device.configureCleaning({ mode: 0, suction: 4 });
  await started;
  await assert.rejects(preset, (error: unknown) => error instanceof VacuumStateError && error.state.status === 6);
  assert.equal(emulator.writes().length, 0);
  assert.equal(device.state?.status, 6, 'A domain error preserves the genuine latest state');
  device.close();
});

test('preset guard rejects paused, returning, upgrading and faulted robots before writes', async () => {
  const { emulator, device } = fixture();
  for (const status of [2, 3, 5, 6, 7, 8]) {
    emulator.values.set('2/1', status);
    await assert.rejects(device.configureCleaning({ mode: 2, water: 1 }), VacuumStateError);
  }
  emulator.values.set('2/1', 4);
  emulator.values.set('2/2', 123);
  await assert.rejects(device.configureCleaning({ mode: 2, water: 1 }), VacuumStateError);
  assert.equal(emulator.writes().length, 0);
  emulator.values.set('2/2', 0);
  assert.equal((await device.configureCleaning({ mode: 2, water: 1 })).mode, 2);
  device.close();
});

test('invalid preset values send no requests and partial firmware rejection is not reported as success', async () => {
  const { emulator, device } = fixture();
  await assert.rejects(device.configureCleaning({ mode: 0, suction: 5 }), /Invalid MIoT value/);
  assert.equal(emulator.calls.length, 0);
  emulator.ignoreWrites = true;
  await assert.rejects(device.configureCleaning({ mode: 1, suction: 4 }), /did not apply/);
  assert.equal(device.state, undefined);
  assert.equal(emulator.writes().length, 2, 'No later writes follow a failed readback');
  device.close();
});


test('reasserting matching cleaning settings preserves an externally paused or returning robot', async () => {
  const { emulator, device } = fixture();
  for (const status of [2, 3, 5, 8]) {
    emulator.values.set('2/1', status);
    const state = await device.configureCleaning({ mode: 1, suction: 2, water: 2 });
    assert.equal(state.status, status);
    await assert.rejects(device.configureCleaning({ mode: 1, suction: 4 }), VacuumStateError);
  }
  emulator.values.set('2/2', 123);
  assert.equal((await device.configureCleaning({ mode: 1 })).fault, 123, 'A no-op preserves a real fault');
  assert.equal(emulator.writes().length, 0);
  assert.equal(emulator.actions().length, 0);
  device.close();
});

test('E10 reported full-charge indication permits real preset changes without hiding unknown faults', async () => {
  const { emulator, device } = fixture();
  emulator.values.set('3/1', 100);
  emulator.values.set('2/2', 2105);
  const state = await device.configureCleaning({ mode: 0, suction: 4 });
  assert.equal(state.fault, 2105, 'Preserve the raw diagnostic code');
  assert.equal(state.mode, 0);
  assert.equal(state.suction, 4);
  for (const fault of [123, 2103, 2531]) {
    emulator.values.set('2/2', fault);
    await assert.rejects(device.configureCleaning({ mode: 2 }), error => {
      assert.ok(error instanceof VacuumStateError);
      assert.match(error.message, new RegExp(String(fault)));
      return true;
    });
  }
  device.close();
});
