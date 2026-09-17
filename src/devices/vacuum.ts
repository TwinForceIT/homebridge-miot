import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { MiotTransport } from '../miio/transport.js';
import type { MiotProperty } from './profiles.js';
import { hasVacuumFault, type MiotAction, type VacuumProfile, type VacuumProperty, type VacuumState, type WritableVacuumProperty } from './vacuum-profile.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propertyResult(raw: unknown, property: MiotProperty, write = false): Record<string, unknown> {
  if (!Array.isArray(raw) || raw.length !== 1 || !record(raw[0])) {
    throw new Error(`Invalid MIoT response for ${property.siid}/${property.piid}`);
  }
  const result = raw[0];
  if (result.siid !== property.siid || result.piid !== property.piid || !Number.isInteger(result.code)) {
    throw new Error(`Mismatched MIoT response for ${property.siid}/${property.piid}`);
  }
  if (result.code !== 0 && !(write && result.code === 1)) {
    throw new Error(`MIoT property ${property.siid}/${property.piid} failed (code ${result.code})`);
  }
  return result;
}

function validateValue(value: unknown, property: MiotProperty): number {
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < (property.min ?? -Infinity) || value > (property.max ?? Infinity)) {
    throw new Error(`Invalid MIoT value for ${property.siid}/${property.piid}`);
  }
  return value;
}

export interface VacuumCleaningSettings {
  readonly mode: number;
  readonly suction?: number;
  readonly water?: number;
}

/** A command rejected by valid device state, rather than a communication failure. */
export class VacuumStateError extends Error {
  constructor(message: string, readonly state: VacuumState) { super(message); }
}

/** The command failed, but a fresh reading proves that the device is reachable. */
export class VacuumCommandError extends Error {
  constructor(message: string, readonly state: VacuumState) { super(message); }
}

interface VacuumTiming {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

const CONFIRMATION_MS = 3000;
const CONFIRMATION_POLL_MS = 250;

/** Device transactions are serialized independently of the presentation protocol. */
export class VacuumDevice {
  private queue: Promise<unknown> = Promise.resolve();
  private pendingPoll?: Promise<VacuumState>;
  private snapshot?: VacuumState;
  private closed = false;
  private readonly shutdown = new AbortController();
  private readonly timing: VacuumTiming;

  constructor(
    private readonly transport: MiotTransport,
    readonly profile: VacuumProfile,
    private readonly did?: string,
    timing?: VacuumTiming,
  ) {
    this.timing = timing ?? {
      now: () => performance.now(),
      sleep: milliseconds => delay(milliseconds, undefined, { signal: this.shutdown.signal }),
    };
  }

  get state(): VacuumState | undefined { return this.closed ? undefined : this.snapshot; }

  refresh(): Promise<VacuumState> {
    if (this.pendingPoll) { return this.pendingPoll; }
    const poll = this.enqueue(() => this.readState());
    this.pendingPoll = poll;
    void poll.then(() => { this.pendingPoll = undefined; }, () => { this.pendingPoll = undefined; });
    return poll;
  }

  start(): Promise<VacuumState> { return this.action(this.profile.actions.start, [5, 6, 7]); }
  resume(): Promise<VacuumState> { return this.start(); }
  stop(): Promise<VacuumState> { return this.action(this.profile.actions.stop, [2]); }
  // E10 has no separate standard pause action. stop-sweeping is the MIoT
  // integration's pause fallback; always retain the state returned by firmware.
  pause(): Promise<VacuumState> { return this.stop(); }
  dock(): Promise<VacuumState> { return this.action(this.profile.actions.dock, [3, 4]); }
  setMode(mode: number): Promise<VacuumState> { return this.change('mode', mode); }
  setSuction(level: number): Promise<VacuumState> { return this.change('suction', level); }
  setWater(level: number): Promise<VacuumState> { return this.change('water', level); }

  configureCleaning(settings: VacuumCleaningSettings): Promise<VacuumState> {
    const changes: Array<readonly [WritableVacuumProperty, number]> = [['mode', settings.mode]];
    if (settings.suction !== undefined) changes.push(['suction', settings.suction]);
    if (settings.water !== undefined) changes.push(['water', settings.water]);
    try {
      for (const [name, value] of changes) validateValue(value, this.profile.properties[name]);
    } catch (error) { return Promise.reject(error); }
    return this.command(async () => {
      // Check after earlier queued commands have completed, in the same
      // transaction as all writes. A cached idle reading can race Start.
      const state = await this.readState();
      // Matter permits reasserting the current mode in any state. A repeated
      // preset must neither change settings nor turn a physical pause into an error.
      if (changes.every(([name, value]) => state[name] === value)) return state;
      if (hasVacuumFault(this.profile, state.fault)) {
        throw new VacuumStateError(`Cannot change cleaning settings while Xiaomi fault ${state.fault} is active.`, state);
      }
      if (![0, 1, 4].includes(state.status)) {
        const activity = this.profile.statuses[state.status] ?? `status ${state.status}`;
        throw new VacuumStateError(`Cannot change cleaning settings while ${activity.toLowerCase()}. End the task first.`, state);
      }
      // All preset fields share one settling budget, rather than multiplying
      // the wait by the number of settings. Only reads are repeated.
      const deadline = this.timing.now() + CONFIRMATION_MS;
      for (const [name, value] of changes) await this.writeProperty(this.profile.properties[name], value, deadline);
      const confirmed = await this.readState();
      if (!changes.every(([name, value]) => confirmed[name] === value)) {
        throw new VacuumCommandError('The robot did not retain all requested cleaning settings.', confirmed);
      }
      return confirmed;
    });
  }

  identify(): Promise<VacuumState> {
    return this.command(async () => {
      const property = this.profile.identify;
      propertyResult(await this.request('set_properties', [{ ...this.address(property), value: 1 }]), property, true);
      // Play is a momentary command. Reading alarm=1 cannot prove that the sound
      // played, and a reset value does not mean the device rejected the command.
      return this.readState();
    });
  }

  close(): void {
    this.closed = true;
    this.shutdown.abort();
    this.snapshot = undefined;
    this.transport.close();
  }

  private action(action: MiotAction, expectedStatuses: readonly number[]): Promise<VacuumState> {
    return this.command(async () => {
      const deadline = this.timing.now() + CONFIRMATION_MS;
      const result = await this.request('action', {
        did: this.did ?? `${action.siid}.${action.aiid}`, siid: action.siid, aiid: action.aiid, in: [],
      });
      // Xiaomi's client accepts code-only acknowledgements and code 1 (pending).
      // The transport already matches device/request IDs. Validate echoed action
      // IDs when supplied, without requiring firmware to repeat them.
      if (!record(result) || !Number.isInteger(result.code)
        || ('siid' in result && result.siid !== action.siid)
        || ('aiid' in result && result.aiid !== action.aiid)) {
        const shape = record(result)
          ? ['code', 'siid', 'aiid'].map(key => `${key}=${Number.isInteger(result[key]) ? result[key] : typeof result[key]}`).join(', ')
          : Array.isArray(result) ? `array(${result.length})` : typeof result;
        throw new Error(`Invalid MIoT action response for ${action.siid}/${action.aiid} (${shape})`);
      }
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(`MIoT action ${action.siid}/${action.aiid} failed (code ${result.code})`);
      }
      await this.confirmProperty(this.profile.properties.status, value => expectedStatuses.includes(value), deadline,
        `The robot did not confirm MIoT action ${action.siid}/${action.aiid}`);
      return this.readState();
    });
  }

  private change(name: WritableVacuumProperty, value: number): Promise<VacuumState> {
    const property = this.profile.properties[name];
    try { validateValue(value, property); } catch (error) { return Promise.reject(error); }
    return this.command(async () => {
      await this.writeProperty(property, value, this.timing.now() + CONFIRMATION_MS);
      return this.readState();
    });
  }

  private command(operation: () => Promise<VacuumState>): Promise<VacuumState> {
    return this.enqueue(async () => {
      try {
        return await operation();
      } catch (error) {
        if (this.closed || error instanceof VacuumStateError || error instanceof VacuumCommandError) throw error;
        // A rejected acknowledgement or an unchanged property is not proof of
        // lost communication. Obtain fresh state before deciding availability.
        const state = await this.readState();
        throw new VacuumCommandError(error instanceof Error ? error.message : 'The robot rejected the command.', state);
      }
    });
  }

  private enqueue(operation: () => Promise<VacuumState>): Promise<VacuumState> {
    const result = this.queue.then(async () => {
      if (this.closed) { throw new Error('Vacuum connection is closed'); }
      try {
        const state = await operation();
        if (this.closed) { throw new Error('Vacuum connection is closed'); }
        this.snapshot = state;
        return state;
      } catch (error) {
        this.snapshot = (error instanceof VacuumStateError || error instanceof VacuumCommandError) ? error.state : undefined;
        throw error;
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private address(property: MiotProperty): { did: string; siid: number; piid: number } {
    return { did: this.did ?? `${property.siid}.${property.piid}`, siid: property.siid, piid: property.piid };
  }

  private request(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
    if (this.closed) { return Promise.reject(new Error('Vacuum connection is closed')); }
    return this.transport.request(method, params);
  }

  private async writeProperty(property: MiotProperty, value: number, deadline: number): Promise<void> {
    propertyResult(await this.request('set_properties', [{ ...this.address(property), value }]), property, true);
    await this.confirmProperty(property, observed => observed === value, deadline,
      `Device did not apply MIoT property ${property.siid}/${property.piid}`);
  }

  private async confirmProperty(
    property: MiotProperty, matches: (value: number) => boolean, deadline: number, message: string,
  ): Promise<void> {
    while (true) {
      const value = await this.readProperty(property);
      if (matches(value)) return;
      const remaining = deadline - this.timing.now();
      if (remaining <= 0) throw new Error(`${message} (last value ${value})`);
      await this.timing.sleep(Math.min(CONFIRMATION_POLL_MS, remaining));
      if (this.closed) throw new Error('Vacuum connection is closed');
    }
  }

  private async readProperty(property: MiotProperty): Promise<number> {
    const result = propertyResult(await this.request('get_properties', [this.address(property)]), property);
    return validateValue(result.value, property);
  }

  private async readState(): Promise<VacuumState> {
    const values: Partial<Record<VacuumProperty, number>> = {};
    for (const name of Object.keys(this.profile.properties) as VacuumProperty[]) {
      values[name] = await this.readProperty(this.profile.properties[name]);
    }
    return { ...values, sampledAt: Date.now() } as VacuumState;
  }
}
