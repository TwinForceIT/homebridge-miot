import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { clusters, deviceTypes, MatterStatus, type API, type Logger, type MatterAPI } from 'homebridge';
import { VacuumAccessory } from '../src/matter/vacuum-accessory.js';
import type { MiotParams, MiotTransport } from '../src/miio/transport.js';

interface PropertyRequest { did: string; siid: number; piid: number }
interface ReadGate { entered: () => void; wait: Promise<void> }

/** Firmware readable independently of any phone, Matter command or Identify call. */
class PollingPeer implements MiotTransport {
  readonly calls: Array<{ method: string; property: string }> = [];
  readonly values = new Map<string, number>([
    ['2/1', 4], ['2/2', 0], ['2/4', 0], ['3/1', 100],
    ['7/5', 2], ['7/6', 1], ['7/12', 90], ['7/10', 91], ['7/8', 92], ['7/14', 93],
  ]);
  offline = false;
  closed = false;
  activeRequests = 0;
  maxActiveRequests = 0;
  private nextRead?: ReadGate;
  private cancelRead?: (error: Error) => void;

  holdNextRead(): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>((resolve, reject) => {
      release = resolve;
      this.cancelRead = reject;
    });
    this.nextRead = { entered, wait };
    return { entered: entry, release };
  }

  async request(method: string, params: MiotParams): Promise<unknown> {
    assert.equal(this.closed, false, 'No device I/O may happen after shutdown');
    assert.equal(method, 'get_properties', 'Background polling must never move or identify the robot');
    assert.ok(Array.isArray(params));
    assert.equal(params.length, 1);
    const property = params[0] as PropertyRequest;
    const key = `${property.siid}/${property.piid}`;
    this.calls.push({ method, property: key });
    this.maxActiveRequests = Math.max(this.maxActiveRequests, ++this.activeRequests);
    try {
      const gate = this.nextRead;
      if (gate) {
        this.nextRead = undefined;
        gate.entered();
        await gate.wait;
        this.cancelRead = undefined;
      }
      if (this.offline) throw new Error('Device did not respond.');
      assert.ok(this.values.has(key));
      return [{ ...property, code: 0, value: this.values.get(key) }];
    } finally {
      --this.activeRequests;
    }
  }

  close(): void {
    this.closed = true;
    this.cancelRead?.(new Error('Device connection is closed.'));
    this.cancelRead = undefined;
  }
  get samples(): number { return this.calls.filter(call => call.property === '2/1').length; }
}

function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const peer = new PollingPeer();
  const warnings: string[] = [];
  const information: string[] = [];
  const debug: string[] = [];
  const snapshotReads: string[] = [];
  let snapshotsFail = false;
  const updates: Array<{ cluster: string; attributes: Record<string, unknown> }> = [];
  const published: Record<string, Record<string, unknown>> = {};
  const matter = {
    types: clusters,
    deviceTypes,
    status: MatterStatus,
    getAccessoryState: async (_uuid: string, cluster: string) => {
      snapshotReads.push(cluster);
      if (snapshotsFail) throw new Error('Simulated Matter diagnostic read failure');
      return structuredClone(published[cluster]);
    },
    updateAccessoryState: async (_uuid: string, cluster: string, attributes: Record<string, unknown>) => {
      updates.push({ cluster, attributes: structuredClone(attributes) });
      published[cluster] = { ...published[cluster], ...structuredClone(attributes) };
    },
  } as unknown as MatterAPI;
  const logger = {
    debug: (...messages: unknown[]) => { debug.push(messages.join(' ')); },
    info: (...messages: unknown[]) => { information.push(messages.join(' ')); },
    warn: (...messages: unknown[]) => { warnings.push(messages.join(' ')); },
    error: (...messages: unknown[]) => { warnings.push(messages.join(' ')); },
    success: () => {},
    log: () => {},
  } as unknown as Logger;
  const accessory = new VacuumAccessory({ matter } as API, logger, '00000000-0000-4000-8000-000000000099', {
    name: 'Idle polling E10', model: 'xiaomi.vacuum.b112', host: '192.0.2.99', token: 'd'.repeat(32), did: 'polling-test',
  }, peer, 15);
  context.after(() => accessory.stop());
  const flush = async () => {
    // Drain publication and the later in-memory Matter diagnostic snapshot.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  const tick = async (milliseconds: number) => { context.mock.timers.tick(milliseconds); await flush(); };
  return {
    peer, accessory, published, updates, warnings, information, debug, snapshotReads, flush, tick,
    failSnapshots: (fail: boolean) => { snapshotsFail = fail; },
  };
}

test('background polling publishes real activity and battery for six hours without any controller command', async context => {
  const f = fixture(context);
  f.accessory.start();
  await f.flush();
  assert.equal(f.peer.samples, 1);
  assert.equal(f.published.powerSource!.batPercentRemaining, 200);
  const phases = [
    { status: 4, mode: 0, battery: 100, operationalState: 65, runMode: 0 },
    { status: 5, mode: 0, battery: 83, operationalState: 1, runMode: 1 },
    { status: 2, mode: 0, battery: 81, operationalState: 2, runMode: 1 },
    { status: 6, mode: 1, battery: 65, operationalState: 1, runMode: 1 },
    { status: 3, mode: 1, battery: 47, operationalState: 64, runMode: 0 },
    { status: 4, mode: 1, battery: 90, operationalState: 65, runMode: 0 },
  ];
  for (const [hour, phase] of phases.entries()) {
    // Firmware changes model physical buttons or Xiaomi Home, without invoking
    // any accessory handler, refresh method or Identify operation in this test.
    f.peer.values.set('2/1', phase.status);
    f.peer.values.set('2/4', phase.mode);
    f.peer.values.set('3/1', phase.battery);
    for (let quarterMinute = 0; quarterMinute < 240; quarterMinute++) await f.tick(15_000);
    assert.equal(f.peer.samples, 1 + (hour + 1) * 240, 'Polling continues while no phone is interacting');
    assert.equal(f.published.rvcOperationalState!.operationalState, phase.operationalState);
    assert.deepEqual(f.published.rvcOperationalState!.operationalError, { errorStateId: 0, errorStateDetails: '' });
    assert.equal(f.published.rvcRunMode!.currentMode, phase.runMode);
    assert.equal(f.published.rvcCleanMode!.currentMode, phase.mode);
    assert.equal(f.published.powerSource!.batPercentRemaining, phase.battery * 2);
  }
  assert.equal(f.peer.maxActiveRequests, 1);
  assert.equal(f.warnings.length, 0);
  assert.equal(f.peer.calls.every(call => call.method === 'get_properties'), true);
});

test('a temporarily unreachable robot recovers through background polling without Identify', async context => {
  const f = fixture(context);
  f.accessory.start();
  await f.flush();
  f.peer.offline = true;
  await f.tick(15_000);
  assert.equal(f.published.rvcOperationalState!.operationalState, clusters.RvcOperationalState.OperationalState.Error);
  assert.equal(f.published.powerSource!.batPercentRemaining, null);
  assert.match(JSON.stringify(f.published.rvcOperationalState!.operationalError), /Communication unavailable/);
  const offlineSamples = f.peer.samples;
  await f.tick(15_000);
  assert.equal(f.peer.samples, offlineSamples + 1, 'A failed poll does not stop the timer');
  f.peer.offline = false;
  f.peer.values.set('2/1', 2);
  f.peer.values.set('3/1', 62);
  await f.tick(15_000);
  assert.equal(f.published.rvcOperationalState!.operationalState, clusters.RvcOperationalState.OperationalState.Paused);
  assert.deepEqual(f.published.rvcOperationalState!.operationalError, { errorStateId: 0, errorStateDetails: '' });
  assert.equal(f.published.powerSource!.batPercentRemaining, 124);
  assert.ok(f.information.some(message => message.includes('restored')));
  assert.equal(f.peer.calls.every(call => call.method === 'get_properties'), true);
});

test('a slow poll cannot overlap or accumulate additional polls during a long wait', async context => {
  const f = fixture(context);
  const gate = f.peer.holdNextRead();
  f.accessory.start();
  f.accessory.start();
  await gate.entered;
  await f.tick(3 * 60 * 60 * 1000);
  assert.equal(f.peer.samples, 1);
  assert.equal(f.peer.activeRequests, 1);
  gate.release();
  await f.flush();
  assert.equal(f.peer.samples, 1, 'Missed intervals must not become queued work');
  assert.equal(f.peer.activeRequests, 0);
  await f.tick(15_000);
  assert.equal(f.peer.samples, 2);
  assert.equal(f.peer.maxActiveRequests, 1);
});

test('shutdown cancels scheduled polling and later starts cannot resume device I/O', async context => {
  const f = fixture(context);
  f.accessory.start();
  await f.flush();
  f.accessory.stop();
  const callsAtStop = f.peer.calls.length;
  const updatesAtStop = f.updates.length;
  f.accessory.start();
  await f.tick(6 * 60 * 60 * 1000);
  assert.equal(f.peer.calls.length, callsAtStop);
  assert.equal(f.updates.length, updatesAtStop);
  assert.equal(f.peer.closed, true);
});

test('shutdown during an in-flight poll prevents further reads, publications and timer rearming', async context => {
  const f = fixture(context);
  const gate = f.peer.holdNextRead();
  f.accessory.start();
  await gate.entered;
  f.accessory.stop();
  const callsAtStop = f.peer.calls.length;
  const updatesAtStop = f.updates.length;
  await f.flush();
  await f.tick(6 * 60 * 60 * 1000);
  assert.equal(f.peer.calls.length, callsAtStop);
  assert.equal(f.updates.length, updatesAtStop);
  assert.equal(f.peer.activeRequests, 0);
  assert.equal(f.peer.closed, true);
});


test('failed Matter diagnostic snapshots cannot interrupt polling or mark a reachable robot unavailable', async context => {
  const f = fixture(context);
  f.failSnapshots(true);
  f.accessory.start();
  await f.flush();
  assert.equal(f.peer.samples, 1);
  assert.equal(f.published.powerSource!.batPercentRemaining, 200);
  f.peer.values.set('3/1', 79);
  await f.tick(15_000);
  assert.equal(f.peer.samples, 2);
  assert.equal(f.published.powerSource!.batPercentRemaining, 158);
  assert.deepEqual(f.published.rvcOperationalState!.operationalError, { errorStateId: 0, errorStateDetails: '' });
  assert.ok(f.snapshotReads.length > 0, 'Exercise the failing diagnostic path');
  assert.equal(f.warnings.some(message => message.includes('unavailable')), false);
  f.failSnapshots(false);
  await f.tick(15_000);
  assert.equal(f.peer.samples, 3);
  assert.ok(f.debug.some(message => message.includes('Matter snapshot')));
  f.accessory.stop();
  const readsAtStop = f.snapshotReads.length;
  await f.tick(6 * 60 * 60 * 1000);
  assert.equal(f.snapshotReads.length, readsAtStop, 'Diagnostic reads also stop on shutdown');
});
