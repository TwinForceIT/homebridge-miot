import type { API, Characteristic, CharacteristicValue, Logger, PlatformAccessory, Service } from 'homebridge';
import type { DeviceConfig } from '../config.js';
import type { MiotTransport } from '../miio/transport.js';
import { PurifierDevice } from '../devices/purifier.js';
import { airQualityFromPm25, getPurifierProfile, percentFromFavoriteLevel, type PurifierState } from '../devices/profiles.js';

export class PurifierAccessory {
  private readonly device: PurifierDevice;
  private readonly purifier: Service;
  private readonly airQuality: Service;
  private readonly filter: Service;
  private readonly readable: Characteristic[] = [];
  private readonly pollMilliseconds: number;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private closed = false;
  private lastFault?: number;
  private lastProblem?: string;
  private filterExhausted = false;

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory,
    private readonly config: DeviceConfig,
    transport: MiotTransport,
    pollInterval: number,
  ) {
    this.device = new PurifierDevice(transport, getPurifierProfile(config.model), config.did, { display: config.exposeDisplay === true });
    this.pollMilliseconds = Math.max(10, Number.isFinite(pollInterval) ? pollInterval : 15) * 1000;
    const { Service: S, Characteristic: C } = api.hap;
    this.purifier = accessory.getService(S.AirPurifier) ?? accessory.addService(S.AirPurifier, config.name);
    this.airQuality = accessory.getService(S.AirQualitySensor)
      ?? accessory.addService(S.AirQualitySensor, `${config.name} Air Quality`);
    this.filter = accessory.getService(S.FilterMaintenance)
      ?? accessory.addService(S.FilterMaintenance, `${config.name} Filter`);
    this.purifier.setPrimaryService(true);
    this.purifier.addLinkedService(this.airQuality);
    this.purifier.addLinkedService(this.filter);

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Xiaomi')
      .setCharacteristic(C.Model, config.model)
      .setCharacteristic(C.SerialNumber, config.did ?? config.id ?? accessory.UUID);

    this.bind(this.purifier.getCharacteristic(C.Active), s => Number(s.power),
      value => this.device.setPower(Number(value) === C.Active.ACTIVE));
    this.bind(this.purifier.getCharacteristic(C.CurrentAirPurifierState), s => {
      if (!s.power) { return C.CurrentAirPurifierState.INACTIVE; }
      return s.motorRpm > 0 && s.fault !== 2
        ? C.CurrentAirPurifierState.PURIFYING_AIR : C.CurrentAirPurifierState.IDLE;
    });
    this.bind(this.purifier.getCharacteristic(C.TargetAirPurifierState),
      s => s.mode === 0 ? C.TargetAirPurifierState.AUTO : C.TargetAirPurifierState.MANUAL,
      value => this.device.setMode(Number(value) === C.TargetAirPurifierState.AUTO));
    this.bind(this.purifier.getCharacteristic(C.RotationSpeed).setProps({ minStep: 1,
      perms: [api.hap.Perms.PAIRED_READ, api.hap.Perms.PAIRED_WRITE, api.hap.Perms.NOTIFY, api.hap.Perms.WRITE_RESPONSE] }), s => {
      if (!s.power) { return 0; }
      if (s.mode === 1) { return 1; }
      if (s.mode === 2) { return percentFromFavoriteLevel(s.favoriteLevel); }
      return Math.min(100, Math.round(s.motorRpm / this.device.profile.maximumRpm * 100));
    }, value => this.device.setSpeed(Number(value)));
    this.bind(this.purifier.getCharacteristic(C.LockPhysicalControls), s => Number(s.childLock),
      value => this.device.setChildLock(Number(value) === C.LockPhysicalControls.CONTROL_LOCK_ENABLED));

    this.bind(this.airQuality.getCharacteristic(C.AirQuality),
      s => s.fault === 3 ? C.AirQuality.UNKNOWN : airQualityFromPm25(s.pm25));
    this.bind(this.airQuality.getCharacteristic(C.PM2_5Density), s => {
      if (s.fault === 3) { throw this.communicationError(); }
      return s.pm25;
    });
    this.bind(this.airQuality.getCharacteristic(C.StatusFault),
      s => s.fault === 0 ? C.StatusFault.NO_FAULT : C.StatusFault.GENERAL_FAULT);
    this.bind(this.airQuality.getCharacteristic(C.StatusActive), s => s.fault !== 3);
    this.bind(this.filter.getCharacteristic(C.FilterLifeLevel), s => s.filterLife);
    this.bind(this.filter.getCharacteristic(C.FilterChangeIndication),
      s => s.filterLife === 0 ? C.FilterChangeIndication.CHANGE_FILTER : C.FilterChangeIndication.FILTER_OK);
    // Display brightness is not part of HomeKit's AirPurifier service. This
    // opt-in linked light represents only the physical display backlight.
    const cachedDisplay = accessory.getServiceById(S.Lightbulb, 'display');
    if (config.exposeDisplay === true) {
      const display = cachedDisplay ?? accessory.addService(S.Lightbulb, `${config.name} Display`, 'display');
      this.purifier.addLinkedService(display);
      const displayLevel = (state: PurifierState): number => {
        if (state.displayBrightness === undefined) throw this.communicationError();
        return state.displayBrightness;
      };
      this.bind(display.getCharacteristic(C.On), s => displayLevel(s) > 0,
        value => this.device.setDisplayPower(Boolean(value)));
      this.bind(display.getCharacteristic(C.Brightness).setProps({ minStep: 1,
        perms: [api.hap.Perms.PAIRED_READ, api.hap.Perms.PAIRED_WRITE, api.hap.Perms.NOTIFY, api.hap.Perms.WRITE_RESPONSE] }),
      s => displayLevel(s) * 50, value => this.device.setDisplayBrightness(Number(value)));
    } else if (cachedDisplay) {
      this.purifier.removeLinkedService(cachedDisplay);
      accessory.removeService(cachedDisplay);
    }
    this.markUnavailable();
  }

  start(): void {
    if (this.running || this.closed) { return; }
    this.running = true;
    void this.pollCycle();
  }

  stop(): void {
    if (this.closed) { return; }
    this.running = false;
    this.closed = true;
    clearTimeout(this.timer);
    this.device.close();
    this.markUnavailable();
  }

  /** One complete poll, also useful for deterministic integration verification. */
  async refresh(): Promise<void> {
    if (this.closed) { return; }
    try {
      const state = await this.device.refresh();
      if (!this.closed) { this.publish(state); }
    } catch (error) {
      if (!this.closed) { this.reportUnavailable(error); }
    }
  }

  private async pollCycle(): Promise<void> {
    await this.refresh();
    if (this.running && !this.closed) {
      this.timer = setTimeout(() => { void this.pollCycle(); }, this.pollMilliseconds);
      this.timer.unref();
    }
  }

  private bind(
    characteristic: Characteristic,
    read: (state: PurifierState) => CharacteristicValue,
    write?: (value: CharacteristicValue) => Promise<PurifierState>,
  ): void {
    this.readable.push(characteristic);
    characteristic.onGet(() => read(this.currentState()));
    // Keep a single rendering path for GET responses and pushed updates.
    this.renderers.set(characteristic, read);
    if (write) {
      characteristic.onSet(async value => {
        if (this.closed) { throw this.communicationError(); }
        try {
          const state = await write(value);
          if (this.closed) { throw this.communicationError(); }
          this.publish(state);
          // Preserve the confirmed discrete level rather than caching an
          // arbitrary requested percentage after the handler returns.
          if (characteristic.props.perms.includes(this.api.hap.Perms.WRITE_RESPONSE)) return read(state);
        } catch (error) {
          if (!this.closed) { this.reportUnavailable(error); }
          throw this.communicationError();
        }
      });
    }
  }

  private readonly renderers = new Map<Characteristic, (state: PurifierState) => CharacteristicValue>();

  private currentState(): PurifierState {
    const state = this.device.state;
    if (!state || Date.now() - state.sampledAt > Math.max(30_000, this.pollMilliseconds * 3)) {
      throw this.communicationError();
    }
    return state;
  }

  private communicationError(): Error {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private publish(state: PurifierState): void {
    if (this.lastProblem !== undefined) {
      this.log.info(`${this.config.name}: device communication restored.`);
      this.lastProblem = undefined;
    }
    for (const [characteristic, read] of this.renderers) {
      try { characteristic.updateValue(read(state)); }
      catch { characteristic.updateValue(this.communicationError()); }
    }
    if (state.fault !== this.lastFault) {
      if (state.fault !== 0) {
        this.log.warn(`${this.config.name}: ${this.device.profile.faults[state.fault] ?? 'Unknown device fault'} (MIoT ${state.fault}).`);
      } else if (this.lastFault !== undefined && this.lastFault !== 0) {
        this.log.info(`${this.config.name}: device fault cleared.`);
      }
      this.lastFault = state.fault;
    }
    const exhausted = state.filterLife === 0;
    if (exhausted && !this.filterExhausted) {
      this.log.warn(`${this.config.name}: filter life is 0%; replace the filter.`);
    }
    this.filterExhausted = exhausted;
  }

  private markUnavailable(): void {
    for (const characteristic of this.readable) {
      characteristic.updateValue(this.communicationError());
    }
  }

  private reportUnavailable(error: unknown): void {
    this.markUnavailable();
    // Only our protocol errors are logged verbatim; transport messages may contain
    // data supplied by the device. Never log configuration or raw protocol replies.
    const message = error instanceof Error ? error.message.replace(/[\r\n]/g, ' ').slice(0, 200) : 'Device communication failed';
    if (message !== this.lastProblem) {
      this.log.warn(`${this.config.name}: unavailable (${message}). Check power, LAN address and token.`);
      this.lastProblem = message;
    }
  }
}
