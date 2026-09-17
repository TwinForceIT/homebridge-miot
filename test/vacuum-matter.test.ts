import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as hap from '@homebridge/hap-nodejs';
import { TlvOfModel } from '@matter/types';
import { RvcOperationalState } from '@matter/types/clusters/rvc-operational-state';
import { clusters, deviceTypes, MatterStatus, type API, type Logger, type MatterAPI } from 'homebridge';
import { VacuumAccessory } from '../src/matter/vacuum-accessory.js';
import { getVacuumProfile } from '../src/devices/vacuum-profile.js';
import { VACUUM_CLEAN_MODES } from '../src/matter/vacuum-modes.js';
import type { MiotParams, MiotTransport } from '../src/miio/transport.js';

class VacuumEmulator implements MiotTransport {
  readonly values = new Map<string, number>();
  readonly actions: Array<{ siid: number; aiid: number }> = [];
  readonly writes: Array<{ siid: number; piid: number; value: number }> = [];
  offline = false;
  rejectActions = false;
  omitActionIds = false;
  acknowledgementCode = 0;
  propertyDelayReads = 0;
  actionDelayReads = 0;
  ignorePropertyWrites = false;
  private readonly pending = new Map<string, { value: number; reads: number }>();
  ignoreActions = false;
  revertModeOnLevelWrite = false;
  closed = false;
  reads = 0;
  constructor() {
    const initial = { status: 1, fault: 0, mode: 0, battery: 74, suction: 1, water: 1,
      filterLife: 85, mainBrushLife: 83, sideBrushLife: 82, mopLife: 81 };
    for (const [name, property] of Object.entries(getVacuumProfile('xiaomi.vacuum.b112').properties)) {
      this.values.set(`${property.siid}/${property.piid}`, initial[name as keyof typeof initial]);
    }
  }
  async request(method: string, params: MiotParams): Promise<unknown> {
    assert.equal(this.closed, false);
    if (this.offline) throw new Error('Device did not respond.');
    if (method === 'action') {
      assert.ok(!Array.isArray(params));
      const action = params as { siid: number; aiid: number };
      this.actions.push(action);
      if (!this.rejectActions && !this.ignoreActions) {
        const value = action.siid === 3 ? 3 : action.aiid === 2 ? 2 : 5;
        if (this.actionDelayReads > 0) this.pending.set('2/1', { value, reads: this.actionDelayReads });
        else this.values.set('2/1', value);
      }
      return { ...(this.omitActionIds ? {} : action), code: this.rejectActions ? -4001 : this.acknowledgementCode, out: [] };
    }
    assert.ok(Array.isArray(params));
    const property = params[0] as { siid: number; piid: number; value?: number };
    if (method === 'set_properties') {
      this.writes.push(property as { siid: number; piid: number; value: number });
      if (!this.ignorePropertyWrites) {
        if (this.propertyDelayReads > 0) this.pending.set(`${property.siid}/${property.piid}`, { value: property.value!, reads: this.propertyDelayReads });
        else this.values.set(`${property.siid}/${property.piid}`, property.value!);
      }
      if (this.revertModeOnLevelWrite && property.siid === 7) this.values.set('2/4', 0);
      return [{ ...property, code: this.acknowledgementCode }];
    }
    assert.equal(method, 'get_properties');
    this.reads++;
    const key = `${property.siid}/${property.piid}`;
    const pending = this.pending.get(key);
    if (pending && pending.reads-- === 0) { this.values.set(key, pending.value); this.pending.delete(key); }
    return [{ ...property, code: 0, value: this.values.get(`${property.siid}/${property.piid}`) }];
  }
  close(): void { this.closed = true; }
}

function fixture() {
  const emulator = new VacuumEmulator();
  const warnings: string[] = [];
  const logs: string[] = [];
  const debug: string[] = [];
  const updates: Array<{ cluster: string; attributes: Record<string, unknown> }> = [];
  const matter = {
    types: clusters, deviceTypes, status: MatterStatus,
    getAccessoryState: async (_uuid: string, cluster: string) => accessory.clusters![cluster],
    updateAccessoryState: async (_uuid: string, cluster: string, attributes: Record<string, unknown>) => {
      updates.push({ cluster, attributes });
    },
  } as unknown as MatterAPI;
  const logger = { debug: (message: string) => debug.push(message), warn: (message: string) => warnings.push(message), info: (message: string) => logs.push(message) } as unknown as Logger;
  const controller = new VacuumAccessory({ matter } as API, logger, hap.uuid.generate('vacuum-did-1000'), {
    model: 'xiaomi.vacuum.b112', name: 'E10', host: '192.0.2.50', token: 'a'.repeat(32), did: '1000',
  }, emulator, 15);
  const accessory = controller.accessory;
  const state = (cluster: string) => accessory.clusters![cluster]!;
  const command = async (cluster: string, name: string, request?: Record<string, number>) => {
    const handler = accessory.handlers![cluster]![name]!;
    await handler(request);
  };
  return { emulator, warnings, logs, debug, updates, controller, accessory, state, command, matter };
}

test('E10 is a native Matter vacuum with cleaning modes and no switch, fan or invented room', () => {
  const f = fixture();
  assert.equal(f.accessory.deviceType, deviceTypes.RoboticVacuumCleaner);
  assert.equal(f.accessory.deviceType.deviceType, 0x74);
  assert.deepEqual(Object.keys(f.accessory.clusters!).sort(), ['identify', 'powerSource', 'rvcCleanMode', 'rvcOperationalState', 'rvcRunMode']);
  assert.equal((f.state('rvcCleanMode').supportedModes as unknown[]).length, 17);
  assert.deepEqual((f.state('rvcCleanMode').supportedModes as unknown[]).slice(0, 3), [
    { label: 'Vacuum', mode: 0, modeTags: [{ value: 0x4001 }] },
    { label: 'Vacuum and mop', mode: 1, modeTags: [{ value: 0x4001 }, { value: 0x4002 }] },
    { label: 'Mop', mode: 2, modeTags: [{ value: 0x4002 }] },
  ]);
  assert.equal(f.state('rvcOperationalState').operationalState, clusters.RvcOperationalState.OperationalState.Error);
  assert.equal(f.state('powerSource').batPercentRemaining, null);
  assert.equal(f.state('identify').identifyType, 3);
  assert.ok(!JSON.stringify(f.accessory.context).includes('aaaa'));
  f.controller.stop();
});

test('native state follows MIoT readings and battery uses Matter half-percent units', async () => {
  const f = fixture();
  await f.controller.refresh();
  assert.equal(f.state('powerSource').batPercentRemaining, 148);
  assert.equal(f.state('powerSource').batChargeState, 3);
  for (const [status, op, run] of [[0, 0, 0], [1, 0, 0], [2, 2, 1], [3, 64, 0], [4, 65, 0], [5, 1, 1], [6, 1, 1], [7, 1, 1]]) {
    f.emulator.values.set('2/1', status!);
    await f.controller.refresh();
    assert.equal(f.state('rvcOperationalState').operationalState, op);
    assert.equal(f.state('rvcRunMode').currentMode, run);
    assert.equal(f.state('powerSource').batChargeState, status === 4 ? 1 : 3);
  }
  f.controller.stop();
});

test('native start, pause, resume, dock and Stop use the verified MIoT actions', async () => {
  const f = fixture();
  await f.command('rvcRunMode', 'changeToMode', { newMode: 1 });
  await f.command('rvcOperationalState', 'pause');
  assert.equal(f.state('rvcOperationalState').operationalState, 2);
  await f.command('rvcOperationalState', 'resume');
  await f.command('rvcOperationalState', 'goHome');
  assert.equal(f.state('rvcOperationalState').operationalState, 64);
  await f.command('rvcRunMode', 'changeToMode', { newMode: 0 });
  assert.deepEqual(f.emulator.actions.map(({ siid, aiid }) => [siid, aiid]), [[2, 1], [2, 2], [2, 1], [3, 1]]);
  f.emulator.values.set('2/1', 1);
  f.emulator.ignoreActions = true;
  await assert.rejects(f.command('rvcRunMode', 'changeToMode', { newMode: 1 }), MatterStatus.Failure);
  assert.equal(f.state('rvcOperationalState').operationalState, 0, 'An acknowledgement cannot invent running state');
  assert.equal(f.state('rvcRunMode').currentMode, 0);
  f.controller.stop();
});

test('cleaning-mode validation prevents unsupported or active-state writes', async () => {
  const f = fixture();
  await f.command('rvcCleanMode', 'changeToMode', { newMode: 1 });
  assert.equal(f.state('rvcCleanMode').currentMode, 1);
  assert.deepEqual(f.emulator.writes.map(({ siid, piid, value }) => [siid, piid, value]), [[2, 4, 1]]);
  await assert.rejects(f.command('rvcCleanMode', 'changeToMode', { newMode: 9 }), MatterStatus.ConstraintError);
  await assert.rejects(f.command('rvcRunMode', 'changeToMode', { newMode: 2 }), MatterStatus.ConstraintError);
  for (const status of [2, 3, 5, 6, 7, 8]) {
    f.emulator.values.set('2/1', status);
    await assert.rejects(f.command('rvcCleanMode', 'changeToMode', { newMode: 0 }), MatterStatus.InvalidInState);
  }
  assert.equal(f.emulator.writes.length, 1);
  assert.equal(f.warnings.length, 0, 'An invalid user request is not a communication failure');
  f.controller.stop();
});

test('identify plays a sound but cancellation does not play another sound', async () => {
  const f = fixture();
  await f.command('identify', 'identify', { identifyTime: 3 });
  await f.command('identify', 'identify', { identifyTime: 0 });
  assert.deepEqual(f.emulator.writes.map(({ siid, piid, value }) => [siid, piid, value]), [[4, 1, 1]]);
  f.controller.stop();
});

test('device faults, consumables and connection failures remain distinct and recover', async () => {
  const f = fixture();
  f.emulator.values.set('2/2', 145);
  f.emulator.values.set('7/12', 0);
  await f.controller.refresh();
  await f.controller.refresh();
  assert.equal(f.state('rvcOperationalState').operationalState, 3);
  assert.match(JSON.stringify(f.state('rvcOperationalState').operationalError), /Xiaomi error 145/);
  assert.equal(f.warnings.filter(line => line.includes('Xiaomi device error')).length, 1);
  assert.equal(f.warnings.filter(line => line.includes('filter life')).length, 1);
  f.emulator.offline = true;
  await f.controller.refresh();
  assert.equal(f.state('powerSource').batPercentRemaining, null);
  assert.equal(f.state('powerSource').batChargeState, 0);
  await assert.rejects(f.command('rvcOperationalState', 'goHome'), MatterStatus.Failure);
  assert.match(JSON.stringify(f.state('rvcOperationalState').operationalError), /Communication unavailable/);
  f.emulator.offline = false;
  f.emulator.values.set('2/2', 0);
  f.emulator.values.set('7/12', 100);
  await f.controller.refresh();
  assert.equal(f.state('powerSource').batPercentRemaining, 148);
  assert.equal(f.state('rvcOperationalState').operationalState, 0);
  assert.deepEqual(f.state('rvcOperationalState').operationalError, { errorStateId: 0, errorStateDetails: '' });
  assert.equal(f.logs.filter(line => line.includes('restored')).length, 1);
  assert.equal(f.logs.filter(line => line.includes('fault cleared')).length, 1);
  f.controller.stop();
});

test('rejected actions produce a native Matter failure instead of optimistic success', async () => {
  const f = fixture();
  await f.controller.refresh();
  f.emulator.rejectActions = true;
  await assert.rejects(f.command('rvcRunMode', 'changeToMode', { newMode: 1 }), MatterStatus.Failure);
  assert.equal(f.state('rvcOperationalState').operationalState, 0);
  assert.equal(f.state('powerSource').batPercentRemaining, 148);
  assert.ok(f.warnings.some(line => line.includes('command not completed')));
  assert.ok(f.warnings.every(line => !line.includes('unavailable')));
  f.controller.stop();
  const calls = f.emulator.reads;
  await f.controller.refresh();
  await assert.rejects(f.command('rvcOperationalState', 'resume'), MatterStatus.Failure);
  assert.equal(f.emulator.reads, calls);
});

test('start clears restored health and battery before polling, shutdown cancels polling', async () => {
  const f = fixture();
  f.emulator.offline = true;
  f.state('rvcOperationalState').operationalState = 1;
  f.state('powerSource').batPercentRemaining = 200;
  f.controller.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state('rvcOperationalState').operationalState, 3);
  assert.equal(f.state('powerSource').batPercentRemaining, null);
  f.controller.stop();
  assert.equal(f.emulator.closed, true);
});


test('native suction and water presets round-trip without changing unnamed settings', async () => {
  const f = fixture();
  await f.command('rvcCleanMode', 'changeToMode', { newMode: 23 });
  assert.equal(f.emulator.values.get('2/4'), 1);
  assert.equal(f.emulator.values.get('7/5'), 4);
  assert.equal(f.emulator.values.get('7/6'), 1);
  assert.equal(f.state('rvcCleanMode').currentMode, 23);
  await f.controller.refresh();
  assert.equal(f.state('rvcCleanMode').currentMode, 23);
  await f.command('rvcCleanMode', 'changeToMode', { newMode: 42 });
  assert.equal(f.emulator.values.get('7/5'), 4);
  assert.equal(f.emulator.values.get('7/6'), 3);
  assert.equal(f.state('rvcCleanMode').currentMode, 42);
  f.emulator.values.set('7/6', 2);
  await f.controller.refresh();
  assert.equal(f.state('rvcCleanMode').currentMode, 1, 'An externally changed level invalidates the selected preset');
  await f.command('rvcCleanMode', 'changeToMode', { newMode: 0 });
  assert.equal(f.emulator.values.get('7/5'), 4);
  assert.equal(f.emulator.values.get('7/6'), 2);
  assert.equal(f.state('rvcCleanMode').currentMode, 0);
  assert.equal(new Set(VACUUM_CLEAN_MODES.map(mode => mode.mode)).size, 17);
  f.controller.stop();
});

test('Homebridge creates the real Matter endpoint, validates updates and routes native commands', async context => {
  // Exercise Homebridge's actual composition and matter.js conformance checks.
  // externalAccessory keeps this node offline: no commissioning or LAN listener.
  const root = import.meta.resolve('homebridge');
  const { MatterServer } = await import(new URL('matter/server.js', root).href);
  const { User } = await import(new URL('user.js', root).href);
  // Generated commissioning codes belong only to this disposable offline node.
  context.mock.method(console, 'log', () => {});
  context.mock.method(console, 'error', () => {});
  const directory = await mkdtemp(join(tmpdir(), 'miot-matter-endpoint-'));
  User.setStoragePath(directory);
  const server = new MatterServer({
    uniqueId: 'MIOT-E10-TEST', storagePath: join(directory, 'matter'),
    externalAccessory: true, displayName: 'E10 Test',
  });
  const f = fixture();
  const pending: Promise<void>[] = [];
  // The real Homebridge API emits an update event and returns immediately. State
  // mutation is deferred until the command's Matter transaction has finished.
  f.matter.updateAccessoryState = async (uuid: string, cluster: string, attributes: Record<string, unknown>) => {
    pending.push(server.updateAccessoryState(uuid, cluster, attributes));
  };
  const flush = async () => { await Promise.all(pending.splice(0)); };
  const read = (cluster: string) => server.getAccessoryState(f.accessory.UUID, cluster);
  const assertClearOperationalError = () => {
    const error = read('rvcOperationalState').operationalError;
    assert.equal(error.errorStateId, 0);
    assert.equal(error.errorStateDetails, '', 'Healthy state must erase previous communication or device error details');
    assert.equal(error.errorStateLabel, undefined, 'Standard NoError must not carry a manufacturer error label');
    // Round-trip the live endpoint value through Matter's generated schema,
    // exercising what would be encoded on the wire rather than only our cache.
    const schema = TlvOfModel(RvcOperationalState.attributes.operationalError);
    assert.deepEqual(schema.decode(schema.encode(error)), { errorStateId: 0, errorStateDetails: '' });
  };
  try {
    await server.start();
    await server.registerPlatformAccessories('test-plugin', 'Test', [f.accessory]);
    assert.equal(read('rvcOperationalState').operationalState, 3);
    assert.equal(read('powerSource').batPercentRemaining, null);
    assert.equal(read('powerSource').featureMap.battery, true);
    assert.equal(read('powerSource').featureMap.rechargeable, true);
    assert.ok(read('descriptor').deviceTypeList.some((entry: { deviceType: number }) => entry.deviceType === 0x11));
    assert.equal(read('rvcCleanMode').supportedModes.length, 17);
    // Clearing an error is a nested struct update. Omitted fields are merged,
    // so a correct ID alone does not guarantee that stale error text is gone.
    await f.controller.refresh();
    await flush();
    assertClearOperationalError();
    await f.controller.refresh();
    await flush();
    assertClearOperationalError();
    assert.equal(f.emulator.actions.length, 0);
    assert.equal(f.emulator.writes.length, 0, 'Recovery must not need Identify or any other user command');
    f.emulator.revertModeOnLevelWrite = true;
    await assert.rejects(server.triggerCommand(f.accessory.UUID, 'rvcCleanMode', 'changeToMode', { newMode: 23 }));
    await flush();
    assert.equal(read('rvcCleanMode').currentMode, 0, 'A later level write must not mask a reverted task mode');
    f.emulator.revertModeOnLevelWrite = false;
    await f.controller.refresh();
    await flush();
    assert.equal(read('powerSource').batPercentRemaining, 148);
    const warningsBeforeCommands = f.warnings.length;
    f.emulator.omitActionIds = true;
    f.emulator.acknowledgementCode = 1;
    f.emulator.propertyDelayReads = 2;
    f.emulator.actionDelayReads = 2;
    await server.triggerCommand(f.accessory.UUID, 'rvcCleanMode', 'changeToMode', { newMode: 42 });
    await flush();
    assert.equal(read('rvcCleanMode').currentMode, 42);
    await server.triggerCommand(f.accessory.UUID, 'rvcRunMode', 'changeToMode', { newMode: 1 });
    await flush();
    assert.equal(read('rvcOperationalState').operationalState, 1);
    assert.equal(read('rvcRunMode').currentMode, 1);
    await server.triggerCommand(f.accessory.UUID, 'rvcOperationalState', 'pause');
    await flush();
    assert.equal(read('rvcOperationalState').operationalState, 2);
    assert.equal(read('rvcOperationalState').operationalError.errorStateId, 0);
    assert.equal(read('powerSource').batPercentRemaining, 148);
    assert.equal(f.warnings.length, warningsBeforeCommands, 'Delayed confirmations must succeed through the real Matter endpoint');
    const pausedActions = f.emulator.actions.length;
    const pausedWrites = f.emulator.writes.length;
    // Exercise the full Homebridge handler -> matter.js base behavior sequence.
    f.emulator.values.set('2/2', 2105);
    f.emulator.values.set('3/1', 100);
    await server.triggerCommand(f.accessory.UUID, 'rvcCleanMode', 'changeToMode', { newMode: 42 });
    await flush();
    await server.triggerCommand(f.accessory.UUID, 'rvcRunMode', 'changeToMode', { newMode: 1 });
    await flush();
    assert.equal(read('rvcOperationalState').operationalState, 2);
    assert.equal(read('rvcOperationalState').operationalError.errorStateId, 0);
    assert.equal(read('rvcCleanMode').currentMode, 42);
    assert.equal(f.emulator.actions.length, pausedActions);
    assert.equal(f.emulator.writes.length, pausedWrites);
    await assert.rejects(server.triggerCommand(f.accessory.UUID, 'rvcCleanMode', 'changeToMode', { newMode: 41 }));
    await flush();
    assert.equal(read('rvcOperationalState').operationalState, 2, 'Rejecting an actual setting change is not a robot fault');
    assert.equal(read('rvcOperationalState').operationalError.errorStateId, 0);
    f.emulator.values.set('2/2', 0);
    f.emulator.values.set('3/1', 74);
    await assert.rejects(server.triggerCommand(f.accessory.UUID, 'rvcCleanMode', 'changeToMode', { newMode: 0 }));
    await flush();
    assert.equal(read('rvcCleanMode').currentMode, 42);
    f.emulator.ignoreActions = true;
    f.emulator.values.set('2/1', 4);
    await f.controller.refresh();
    await flush();
    const actionCount = f.emulator.actions.length;
    await assert.rejects(server.triggerCommand(f.accessory.UUID, 'rvcRunMode', 'changeToMode', { newMode: 1 }));
    await flush();
    assert.equal(f.emulator.actions.length, actionCount + 1, 'Unconfirmed actions are never replayed');
    assert.equal(read('rvcRunMode').currentMode, 0, 'Homebridge must not overwrite the observed mode after rejected transition');
    assert.equal(read('rvcOperationalState').operationalState, 65);
    f.emulator.values.set('2/2', 1234);
    await f.controller.refresh();
    await flush();
    assert.equal(read('rvcOperationalState').operationalState, 3);
    assert.match(read('rvcOperationalState').operationalError.errorStateDetails, /1234/);
    f.emulator.values.set('2/2', 0);
    await f.controller.refresh();
    await flush();
    assertClearOperationalError();
    f.emulator.offline = true;
    await f.controller.refresh();
    await flush();
    assert.equal(read('powerSource').batPercentRemaining, null);
    assert.match(read('rvcOperationalState').operationalError.errorStateDetails, /unavailable/);
    f.emulator.offline = false;
    await f.controller.refresh();
    await flush();
    assertClearOperationalError();
    assert.equal(read('powerSource').batPercentRemaining, 148);
  } finally {
    f.controller.stop();
    await flush();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});


test('physical pause, return and a full-charge indication remain native states without false faults', async () => {
  const f = fixture();
  try {
    f.emulator.values.set('3/1', 100);
    f.emulator.values.set('2/2', 2105);
    for (const [status, expected] of [[4, 65], [5, 1], [2, 2], [3, 64], [4, 65]]) {
      f.emulator.values.set('2/1', status!);
      await f.controller.refresh();
      assert.equal(f.state('rvcOperationalState').operationalState, expected);
      assert.deepEqual(f.state('rvcOperationalState').operationalError, { errorStateId: 0, errorStateDetails: '' });
      await f.command('rvcCleanMode', 'changeToMode', { newMode: 0 });
    }
    assert.equal(f.emulator.actions.length, 0);
    assert.equal(f.emulator.writes.length, 0);
    assert.equal(f.warnings.length, 0);
    f.emulator.values.set('2/2', 2531);
    await f.controller.refresh();
    assert.equal(f.state('rvcOperationalState').operationalState, 3);
    assert.match(JSON.stringify(f.state('rvcOperationalState').operationalError), /2531/);
    await f.command('rvcCleanMode', 'changeToMode', { newMode: 0 });
    assert.equal(f.state('rvcOperationalState').operationalState, 3, 'No-op does not clear an unknown fault');
    await assert.rejects(f.command('rvcCleanMode', 'changeToMode', { newMode: 2 }), MatterStatus.InvalidInState);
    f.emulator.values.set('2/2', 2105);
    await f.controller.refresh();
    assert.equal(f.state('rvcOperationalState').operationalState, 65);
    assert.equal(f.logs.filter(line => line.includes('fault cleared')).length, 1);
    assert.equal(f.warnings.length, 1);
  } finally { f.controller.stop(); }
});

test('repeated Matter run mode preserves physical pause and docking without replaying actions', async () => {
  const f = fixture();
  try {
    for (const [status, runMode, expected] of [[2, 1, 2], [3, 0, 64], [4, 0, 65]]) {
      f.emulator.values.set('2/1', status!);
      await f.command('rvcRunMode', 'changeToMode', { newMode: runMode! });
      assert.equal(f.state('rvcOperationalState').operationalState, expected);
    }
    assert.equal(f.emulator.actions.length, 0, 'A repeated run mode must not start or dock the robot');
    f.emulator.values.set('2/1', 2);
    await f.command('rvcOperationalState', 'resume');
    assert.equal(f.state('rvcOperationalState').operationalState, 1, 'An explicit Resume still resumes');
    assert.equal(f.emulator.actions.length, 1);
  } finally { f.controller.stop(); }
});


test('code-only pause and asynchronous mode writes never publish communication failure', async () => {
  const f = fixture();
  try {
    f.emulator.values.set('2/1', 5);
    f.emulator.omitActionIds = true;
    f.emulator.acknowledgementCode = 1;
    await f.command('rvcOperationalState', 'pause');
    assert.equal(f.state('rvcOperationalState').operationalState, 2);
    assert.deepEqual(f.state('rvcOperationalState').operationalError, { errorStateId: 0, errorStateDetails: '' });
    f.emulator.values.set('2/1', 4);
    f.emulator.propertyDelayReads = 2;
    await f.command('rvcCleanMode', 'changeToMode', { newMode: 1 });
    assert.equal(f.state('rvcCleanMode').currentMode, 1);
    assert.equal(f.state('rvcOperationalState').operationalState, 65);
    assert.equal(f.state('powerSource').batPercentRemaining, 148);
    assert.equal(f.emulator.actions.length, 1);
    assert.equal(f.emulator.writes.length, 1);
    assert.equal(f.warnings.length, 0);
    assert.ok(f.updates.every(update => update.cluster !== 'powerSource' || update.attributes.batPercentRemaining !== null));
    assert.ok(f.updates.every(update => update.cluster !== 'rvcOperationalState' || update.attributes.operationalState !== 3));
  } finally { f.controller.stop(); }
});

test('an unsettled setting rejects the command while preserving actual healthy robot state', async () => {
  const f = fixture();
  try {
    await f.controller.refresh();
    f.emulator.ignorePropertyWrites = true;
    await assert.rejects(f.command('rvcCleanMode', 'changeToMode', { newMode: 1 }), MatterStatus.Failure);
    assert.equal(f.state('rvcCleanMode').currentMode, 0);
    assert.equal(f.state('rvcOperationalState').operationalState, 0);
    assert.deepEqual(f.state('rvcOperationalState').operationalError, { errorStateId: 0, errorStateDetails: '' });
    assert.equal(f.state('powerSource').batPercentRemaining, 148);
    assert.equal(f.emulator.writes.length, 1);
    assert.ok(f.warnings.every(line => !line.includes('unavailable')));
    await f.controller.refresh();
    assert.ok(f.logs.every(line => !line.includes('communication restored')));
  } finally { f.controller.stop(); }
});
