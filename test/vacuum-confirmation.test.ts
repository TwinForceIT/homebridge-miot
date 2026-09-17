import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVacuumProfile } from '../src/devices/vacuum-profile.js';
import { VacuumCommandError, VacuumDevice } from '../src/devices/vacuum.js';
import type { MiotParams, MiotTransport } from '../src/miio/transport.js';

interface PropertyRequest { did: string; siid: number; piid: number; value?: number }
interface ActionRequest { did: string; siid: number; aiid: number; in: unknown[] }

/** An independent peer whose firmware updates happen after acknowledgements. */
class DelayedVacuum implements MiotTransport {
  readonly calls: Array<{ method: string; params: MiotParams; at: number }> = [];
  readonly values = new Map<string, number>([
    ['2/1', 4], ['2/2', 0], ['2/4', 0], ['3/1', 80],
    ['7/5', 2], ['7/6', 1], ['7/12', 87], ['7/10', 82], ['7/8', 73], ['7/14', 65],
  ]);
  private readonly pending: Array<{ key: string; value: number; at: number }> = [];
  actionReply: unknown = { code: 0 };
  writeCode = 0;
  actionDelay: number | null = 750;
  propertyDelay: number | null = 750;
  readFailure = false;
  failReadAfterCommand = false;
  closed = false;
  onCommand?: () => void;

  constructor(private readonly now: () => number) {}

  async request(method: string, params: MiotParams): Promise<unknown> {
    assert.equal(this.closed, false, 'No I/O may follow close, including a delayed confirmation read');
    this.calls.push({ method, params, at: this.now() });
    if (method === 'action') {
      assert.equal(Array.isArray(params), false);
      const action = params as unknown as ActionRequest;
      const key = `${action.siid}/${action.aiid}`;
      const target = key === '2/1' ? 5 + this.values.get('2/4')! : key === '2/2' ? 2 : 3;
      if (this.actionDelay !== null) {
        this.pending.push({ key: '2/1', value: target, at: this.now() + this.actionDelay });
      }
      this.onCommand?.();
      if (this.failReadAfterCommand) this.readFailure = true;
      return this.actionReply;
    }
    assert.ok(Array.isArray(params));
    assert.equal(params.length, 1);
    const property = params[0] as PropertyRequest;
    const key = `${property.siid}/${property.piid}`;
    if (method === 'set_properties') {
      if (this.propertyDelay !== null && [0, 1].includes(this.writeCode)) {
        this.pending.push({ key, value: property.value!, at: this.now() + this.propertyDelay });
      }
      this.onCommand?.();
      if (this.failReadAfterCommand) this.readFailure = true;
      return [{ did: property.did, siid: property.siid, piid: property.piid, code: this.writeCode }];
    }
    assert.equal(method, 'get_properties');
    if (this.readFailure) throw new Error('Simulated read timeout');
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const change = this.pending[index]!;
      if (change.at <= this.now()) {
        this.values.set(change.key, change.value);
        this.pending.splice(index, 1);
      }
    }
    assert.ok(this.values.has(key), `Unexpected property ${key}`);
    return [{ did: property.did, siid: property.siid, piid: property.piid, code: 0, value: this.values.get(key) }];
  }

  close(): void { this.closed = true; }
  commands() { return this.calls.filter(call => call.method !== 'get_properties'); }
}

function fixture() {
  let elapsed = 0;
  const sleeps: number[] = [];
  let afterSleep: (() => void) | undefined;
  const timing = {
    now: () => elapsed,
    sleep: async (milliseconds: number) => {
      assert.ok(milliseconds > 0, 'Confirmation must yield between attempts');
      sleeps.push(milliseconds);
      elapsed += milliseconds;
      afterSleep?.();
    },
  };
  const peer = new DelayedVacuum(timing.now);
  const device = new VacuumDevice(peer, getVacuumProfile('xiaomi.vacuum.b112'), 'test-vacuum', timing);
  return { peer, device, sleeps, elapsed: () => elapsed, afterSleep: (callback: () => void) => { afterSleep = callback; } };
}

for (const code of [0, 1]) {
  test(`code-only action acknowledgement ${code} confirms a delayed pause without repeating it`, async () => {
    const { peer, device, elapsed } = fixture();
    peer.values.set('2/1', 6);
    peer.actionReply = { code };
    const state = await device.pause();
    assert.equal(state.status, 2);
    assert.equal(device.state?.status, 2);
    assert.ok(elapsed() >= peer.actionDelay!);
    assert.equal(peer.commands().length, 1, 'A delayed action must never be replayed');
    const confirmationReads = peer.calls.filter(call => call.method === 'get_properties' && call.at < peer.actionDelay!);
    assert.ok(confirmationReads.length > 1);
    assert.ok(confirmationReads.every(call => {
      const property = (call.params as PropertyRequest[])[0]!;
      return property.siid === 2 && property.piid === 1;
    }), 'While waiting for Pause, only the changing status needs repeated reads');
    device.close();
  });
}

test('a pending mode write is confirmed from firmware before completing, without resending', async () => {
  const { peer, device, elapsed } = fixture();
  peer.writeCode = 1;
  const state = await device.setMode(2);
  assert.equal(state.mode, 2);
  assert.equal(device.state?.mode, 2);
  assert.ok(elapsed() >= peer.propertyDelay!);
  assert.equal(peer.commands().length, 1);
  device.close();
});

test('delayed Start and dock actions publish their observed states after confirmation', async () => {
  const { peer, device } = fixture();
  peer.values.set('2/4', 1);
  assert.equal((await device.start()).status, 6);
  assert.equal((await device.dock()).status, 3);
  assert.equal(peer.commands().length, 2);
  device.close();
});

for (const [description, reply] of [
  ['mismatched service', { siid: 3, aiid: 2, code: 0 }],
  ['mismatched action', { siid: 2, aiid: 1, code: 0 }],
  ['negative result', { code: -4004 }],
  ['malformed result', { code: '0' }],
] as const) {
  test(`${description} rejects the command while retaining freshly read device health`, async () => {
    const { peer, device } = fixture();
    await device.refresh();
    peer.actionDelay = null;
    peer.actionReply = reply;
    peer.onCommand = () => peer.values.set('3/1', 63);
    await assert.rejects(device.pause(), (error: unknown) => {
      assert.ok(error instanceof VacuumCommandError);
      assert.equal(error.state.battery, 63, 'Retain fresh readings, not the pre-command snapshot');
      assert.equal(error.state.status, 4);
      return true;
    });
    assert.equal(device.state?.battery, 63);
    assert.equal(peer.commands().length, 1);
    device.close();
  });
}

test('a rejected property does not masquerade as a communication failure', async () => {
  const { peer, device } = fixture();
  peer.writeCode = -4004;
  await assert.rejects(device.setMode(2), (error: unknown) => {
    assert.ok(error instanceof VacuumCommandError);
    assert.match(error.message, /-4004/);
    assert.equal(error.state.mode, 0);
    return true;
  });
  assert.equal(device.state?.mode, 0);
  assert.equal(peer.commands().length, 1);
  device.close();
});

test('an acknowledged action that never takes effect fails within the deadline and preserves actual status', async () => {
  const { peer, device, elapsed } = fixture();
  peer.actionReply = { code: 1 };
  peer.actionDelay = null;
  peer.values.set('2/1', 6);
  await assert.rejects(device.pause(), (error: unknown) => {
    assert.ok(error instanceof VacuumCommandError);
    assert.equal(error.state.status, 6, 'Never fabricate a paused state from the acknowledgement');
    return true;
  });
  assert.equal(device.state?.status, 6);
  assert.ok(elapsed() > 0 && elapsed() <= 3000);
  assert.equal(peer.commands().length, 1);
  device.close();
});

test('all changes in one cleaning preset share a single confirmation deadline', async () => {
  const { peer, device, elapsed } = fixture();
  peer.writeCode = 1;
  peer.propertyDelay = 1200;
  await assert.rejects(device.configureCleaning({ mode: 2, suction: 4, water: 3 }), (error: unknown) => {
    assert.ok(error instanceof VacuumCommandError);
    assert.equal(error.state.mode, 2, 'Earlier applied settings remain visible after a partial operation');
    return true;
  });
  assert.ok(elapsed() > 0 && elapsed() <= 3000, 'A three-property preset must not wait three full deadlines');
  const keys = peer.commands().map(call => {
    assert.equal(call.method, 'set_properties');
    const property = (call.params as PropertyRequest[])[0]!;
    return `${property.siid}/${property.piid}`;
  });
  assert.equal(new Set(keys).size, keys.length, 'Each setting is written at most once');
  assert.equal(device.state?.mode, 2);
  device.close();
});

test('a failed read after an acknowledgement invalidates cached health', async () => {
  const { peer, device } = fixture();
  await device.refresh();
  peer.failReadAfterCommand = true;
  await assert.rejects(device.pause(), /read timeout/);
  assert.equal(device.state, undefined);
  assert.equal(peer.commands().length, 1);
  device.close();
});

test('closing while confirmation waits prevents all subsequent I/O', async () => {
  const { peer, device, afterSleep } = fixture();
  peer.actionDelay = null;
  let callsAtClose = -1;
  afterSleep(() => {
    callsAtClose = peer.calls.length;
    device.close();
  });
  await assert.rejects(device.pause(), /closed/i);
  assert.ok(callsAtClose > 0);
  assert.equal(peer.calls.length, callsAtClose);
  assert.equal(device.state, undefined);
  assert.equal(peer.closed, true);
});
