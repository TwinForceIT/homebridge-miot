import type { MiotTransport } from '../miio/transport.js';
import type { MiotProperty } from './profiles.js';
import type { MiotAction, VacuumProfile, VacuumProperty, VacuumState, WritableVacuumProperty } from './vacuum-profile.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propertyResult(raw: unknown, property: MiotProperty): Record<string, unknown> {
  if (!Array.isArray(raw) || raw.length !== 1 || !record(raw[0])) {
    throw new Error(`Invalid MIoT response for ${property.siid}/${property.piid}`);
  }
  const result = raw[0];
  if (result.siid !== property.siid || result.piid !== property.piid || !Number.isInteger(result.code)) {
    throw new Error(`Mismatched MIoT response for ${property.siid}/${property.piid}`);
  }
  if (result.code !== 0) {
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

/** Device transactions are serialized independently of the presentation protocol. */
export class VacuumDevice {
  private queue: Promise<unknown> = Promise.resolve();
  private pendingPoll?: Promise<VacuumState>;
  private snapshot?: VacuumState;
  private closed = false;

  constructor(private readonly transport: MiotTransport, readonly profile: VacuumProfile, private readonly did?: string) {}

  get state(): VacuumState | undefined { return this.closed ? undefined : this.snapshot; }

  refresh(): Promise<VacuumState> {
    if (this.pendingPoll) { return this.pendingPoll; }
    const poll = this.enqueue(() => this.readState());
    this.pendingPoll = poll;
    void poll.then(() => { this.pendingPoll = undefined; }, () => { this.pendingPoll = undefined; });
    return poll;
  }

  start(): Promise<VacuumState> { return this.action(this.profile.actions.start); }
  resume(): Promise<VacuumState> { return this.start(); }
  stop(): Promise<VacuumState> { return this.action(this.profile.actions.stop); }
  // E10 has no separate standard pause action. stop-sweeping is the MIoT
  // integration's pause fallback; always retain the state returned by firmware.
  pause(): Promise<VacuumState> { return this.stop(); }
  dock(): Promise<VacuumState> { return this.action(this.profile.actions.dock); }
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
    return this.enqueue(async () => {
      // Check after earlier queued commands have completed, in the same
      // transaction as all writes. A cached idle reading can race Start.
      const state = await this.readState();
      if (![0, 1, 4].includes(state.status) || state.fault !== 0) {
        throw new VacuumStateError('Stop cleaning and clear device errors before changing the cleaning mode.', state);
      }
      for (const [name, value] of changes) await this.writeProperty(this.profile.properties[name], value);
      return this.readState();
    });
  }

  identify(): Promise<VacuumState> {
    return this.enqueue(async () => {
      const property = this.profile.identify;
      propertyResult(await this.request('set_properties', [{ ...this.address(property), value: 1 }]), property);
      // Play is a momentary command. Reading alarm=1 cannot prove that the sound
      // played, and a reset value does not mean the device rejected the command.
      return this.readState();
    });
  }

  close(): void {
    this.closed = true;
    this.snapshot = undefined;
    this.transport.close();
  }

  private action(action: MiotAction): Promise<VacuumState> {
    return this.enqueue(async () => {
      const result = await this.request('action', {
        did: this.did ?? `${action.siid}.${action.aiid}`, siid: action.siid, aiid: action.aiid, in: [],
      });
      if (!record(result) || result.siid !== action.siid || result.aiid !== action.aiid || !Number.isInteger(result.code)) {
        throw new Error(`Invalid MIoT action response for ${action.siid}/${action.aiid}`);
      }
      if (result.code !== 0) {
        throw new Error(`MIoT action ${action.siid}/${action.aiid} failed (code ${result.code})`);
      }
      // Actions can initiate asynchronous movement. A successful acknowledgement
      // does not establish a target state: publish only the subsequent readings.
      return this.readState();
    });
  }

  private change(name: WritableVacuumProperty, value: number): Promise<VacuumState> {
    const property = this.profile.properties[name];
    try { validateValue(value, property); } catch (error) { return Promise.reject(error); }
    return this.enqueue(async () => {
      await this.writeProperty(property, value);
      return this.readState();
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
        this.snapshot = error instanceof VacuumStateError ? error.state : undefined;
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

  private async writeProperty(property: MiotProperty, value: number): Promise<void> {
    propertyResult(await this.request('set_properties', [{ ...this.address(property), value }]), property);
    if (await this.readProperty(property) !== value) {
      throw new Error(`Device did not apply MIoT property ${property.siid}/${property.piid}`);
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
