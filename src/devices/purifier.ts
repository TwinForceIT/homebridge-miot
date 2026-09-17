import type { MiotTransport } from '../miio/transport.js';
import {
  favoriteLevelFromPercent,
  type MiotProperty,
  type PurifierProfile,
  type PurifierProperty,
  type PurifierState,
  type WritablePurifierProperty,
} from './profiles.js';

interface PropertyResult {
  siid: number;
  piid: number;
  code: number;
  value?: unknown;
}

function resultFor(raw: unknown, property: MiotProperty): PropertyResult {
  if (!Array.isArray(raw) || raw.length !== 1 || !raw[0] || typeof raw[0] !== 'object') {
    throw new Error(`Invalid MIoT response for ${property.siid}/${property.piid}`);
  }
  const result = raw[0] as Partial<PropertyResult>;
  if (result.siid !== property.siid || result.piid !== property.piid || !Number.isInteger(result.code)) {
    throw new Error(`Mismatched MIoT response for ${property.siid}/${property.piid}`);
  }
  if (result.code !== 0) {
    throw new Error(`MIoT property ${property.siid}/${property.piid} failed (code ${result.code})`);
  }
  return result as PropertyResult;
}

function validateValue(value: unknown, property: MiotProperty): boolean | number {
  if (property.format === 'boolean' && typeof value === 'boolean') {
    return value;
  }
  if (property.format === 'integer' && typeof value === 'number' && Number.isInteger(value)
    && value >= (property.min ?? -Infinity) && value <= (property.max ?? Infinity)) {
    return value;
  }
  throw new Error(`Invalid MIoT value for ${property.siid}/${property.piid}`);
}

/** Serializes complete transactions, so polling never races a multi-property write. */
export class PurifierDevice {
  private queue: Promise<unknown> = Promise.resolve();
  private pendingPoll?: Promise<PurifierState>;
  private snapshot?: PurifierState;
  private closed = false;
  private lastDisplayBrightness = 2;

  constructor(
    private readonly transport: MiotTransport,
    readonly profile: PurifierProfile,
    private readonly did?: string,
    private readonly options: { display?: boolean } = {},
  ) {}

  get state(): PurifierState | undefined {
    return this.closed ? undefined : this.snapshot;
  }

  refresh(): Promise<PurifierState> {
    if (this.pendingPoll) {
      return this.pendingPoll;
    }
    const poll = this.enqueue(() => this.readState());
    this.pendingPoll = poll;
    void poll.then(() => { this.pendingPoll = undefined; }, () => { this.pendingPoll = undefined; });
    return poll;
  }

  setPower(power: boolean): Promise<PurifierState> {
    return this.change([['power', power]]);
  }

  setMode(automatic: boolean): Promise<PurifierState> {
    return this.enqueue(async () => {
      // HAP has only Auto and Manual. Sleep is represented as Manual at 1%,
      // so a repeated Manual write must not cancel Sleep selected elsewhere.
      const mode = await this.readProperty(this.profile.properties.mode);
      if (automatic ? mode === 0 : mode === 1 || mode === 2) {
        return this.readState();
      }
      return this.applyChanges([['mode', automatic ? 0 : 2]]);
    });
  }

  setChildLock(locked: boolean): Promise<PurifierState> {
    return this.change([['childLock', locked]]);
  }

  setSpeed(percent: number): Promise<PurifierState> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return Promise.reject(new Error('Speed must be between 0 and 100 percent.'));
    }
    if (percent === 0) {
      return this.setPower(false);
    }
    if (percent <= 1) {
      return this.change([['mode', 1], ['power', true]]);
    }
    return this.change([
      ['favoriteLevel', favoriteLevelFromPercent(Math.max(2, percent))],
      ['mode', 2],
      ['power', true],
    ]);
  }

  setDisplayBrightness(percent: number): Promise<PurifierState> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return Promise.reject(new Error('Display brightness must be between 0 and 100 percent.'));
    }
    if (!this.options.display) {
      return Promise.reject(new Error('Display controls are disabled.'));
    }
    const level = percent === 0 ? 0 : percent <= 50 ? 1 : 2;
    return this.enqueue(async () => {
      const current = await this.readDisplayBrightness();
      return current === level ? this.readState() : this.applyChanges([['displayBrightness', level]]);
    });
  }

  setDisplayPower(on: boolean): Promise<PurifierState> {
    if (!this.options.display) {
      return Promise.reject(new Error('Display controls are disabled.'));
    }
    return this.enqueue(async () => {
      const current = await this.readDisplayBrightness();
      const level = on ? current || this.lastDisplayBrightness : 0;
      return current === level ? this.readState() : this.applyChanges([['displayBrightness', level]]);
    });
  }

  private async readDisplayBrightness(): Promise<number> {
    const level = await this.readProperty(this.profile.properties.displayBrightness) as number;
    if (level !== 0) { this.lastDisplayBrightness = level; }
    return level;
  }

  close(): void {
    this.closed = true;
    this.snapshot = undefined;
    this.transport.close();
  }

  private change(changes: ReadonlyArray<readonly [WritablePurifierProperty, boolean | number]>): Promise<PurifierState> {
    return this.enqueue(() => this.applyChanges(changes));
  }

  private async applyChanges(changes: ReadonlyArray<readonly [WritablePurifierProperty, boolean | number]>): Promise<PurifierState> {
    for (const [name, value] of changes) {
      const property = this.profile.properties[name];
      validateValue(value, property);
      const response = await this.request('set_properties', [{ ...this.address(property), value }]);
      resultFor(response, property);
      // The device must actually report the new value; an acknowledgement alone
      // must not turn into invented state in Apple Home.
      if (await this.readProperty(property) !== value) {
        throw new Error(`Device did not apply MIoT property ${property.siid}/${property.piid}`);
      }
    }
    return this.readState();
  }

  private enqueue(operation: () => Promise<PurifierState>): Promise<PurifierState> {
    const result = this.queue.then(async () => {
      if (this.closed) {
        throw new Error('Purifier connection is closed');
      }
      try {
        const state = await operation();
        if (this.closed) {
          throw new Error('Purifier connection is closed');
        }
        this.snapshot = state;
        return state;
      } catch (error) {
        this.snapshot = undefined;
        throw error;
      }
    });
    // A rejected operation must not poison the queue or prevent recovery polling.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private address(property: MiotProperty): { did: string; siid: number; piid: number } {
    return { did: this.did ?? `${property.siid}.${property.piid}`, siid: property.siid, piid: property.piid };
  }

  private async request(method: string, params: unknown[]): Promise<unknown> {
    if (this.closed) {
      throw new Error('Purifier connection is closed');
    }
    return this.transport.request(method, params);
  }

  private async readProperty(property: MiotProperty): Promise<boolean | number> {
    const result = resultFor(await this.request('get_properties', [this.address(property)]), property);
    return validateValue(result.value, property);
  }

  private async readState(): Promise<PurifierState> {
    const values: Partial<Record<PurifierProperty, boolean | number>> = {};
    // CPA4 firmware is known to become unstable with batched get_properties.
    // Keep exactly one property per request, even if the transport supports more.
    for (const name of Object.keys(this.profile.properties) as PurifierProperty[]) {
      if (name === 'displayBrightness' && !this.options.display) { continue; }
      values[name] = await this.readProperty(this.profile.properties[name]);
    }
    if (typeof values.displayBrightness === 'number' && values.displayBrightness !== 0) {
      this.lastDisplayBrightness = values.displayBrightness;
    }
    return { ...values, sampledAt: Date.now() } as PurifierState;
  }
}
