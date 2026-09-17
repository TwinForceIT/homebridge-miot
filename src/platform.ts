import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { deviceIdentity, parseConfig } from './config.js';
import { getDeviceDefinition, type AccessoryController } from './devices/registry.js';
import { MiioTransport } from './miio/transport.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class XiaomiMiotPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly controllers: AccessoryController[] = [];
  constructor(private readonly log: Logger, private readonly config: PlatformConfig, private readonly api: API) {
    api.on('didFinishLaunching', () => this.launch());
    api.on('shutdown', () => { for (const controller of this.controllers) controller.stop(); });
  }
  configureAccessory(accessory: PlatformAccessory): void { this.cached.set(accessory.UUID, accessory); }
  private findCached(identity: string, claimed: ReadonlySet<string>): PlatformAccessory | undefined {
    const identified = [...this.cached.values()].find(item =>
      !claimed.has(item.UUID) && item.context.identity === identity);
    if (identified) return identified;
    const legacy = this.cached.get(this.api.hap.uuid.generate(`${PLUGIN_NAME}:${identity}`));
    // Older caches did not persist identity. A UUID match is safe only while
    // no newer identity has claimed that cached accessory.
    return legacy && !claimed.has(legacy.UUID) && legacy.context.identity === undefined ? legacy : undefined;
  }
  private allocateUuid(identity: string, claimed: ReadonlySet<string>): string {
    const base = `${PLUGIN_NAME}:${identity}`;
    let uuid = this.api.hap.uuid.generate(base);
    for (let suffix = 1; this.cached.has(uuid) || claimed.has(uuid); suffix++) {
      uuid = this.api.hap.uuid.generate(`${base}:replacement:${suffix}`);
    }
    return uuid;
  }
  private launch(): void {
    // Cached values alone are never proof that an accessory is reachable.
    for (const accessory of this.cached.values()) {
      for (const service of accessory.services) {
        if (service.UUID === this.api.hap.Service.AccessoryInformation.UUID) continue;
        for (const characteristic of service.characteristics) {
          if ([this.api.hap.Characteristic.Name.UUID, this.api.hap.Characteristic.ConfiguredName.UUID].includes(characteristic.UUID)) continue;
          const unavailable = () => new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          characteristic.onGet(() => { throw unavailable(); });
          if (characteristic.props.perms.includes(this.api.hap.Perms.PAIRED_WRITE)) characteristic.onSet(() => { throw unavailable(); });
          characteristic.updateValue(unavailable());
        }
      }
    }
    let parsed: ReturnType<typeof parseConfig>;
    try { parsed = parseConfig(this.config); } catch (error) {
      this.log.error(`Configuration error: ${error instanceof Error ? error.message : 'invalid configuration'}`);
      return;
    }
    const active = new Set<string>();
    for (const device of parsed.devices) {
      const definition = getDeviceDefinition(device.model)!;
      const identity = deviceIdentity(device);
      // A preserved UUID can still contain the IP address from a previous setup.
      // Identity metadata takes precedence over that historical UUID, so a new
      // occupant of the old address cannot steal the existing HomeKit accessory.
      const existing = this.findCached(identity, active)
        ?? (identity !== `host:${device.host}` ? this.findCached(`host:${device.host}`, active) : undefined);
      const accessory = existing ?? new this.api.platformAccessory(device.name, this.allocateUuid(identity, active), definition.category(this.api));
      active.add(accessory.UUID);
      accessory.displayName = device.name;
      // Keep only identity metadata in Homebridge's cache, never credentials.
      accessory.context = { model: device.model, identity };
      const transport = new MiioTransport(device.host, device.token);
      const controller = definition.create(this.api, this.log, accessory, device, transport, parsed.pollInterval);
      this.controllers.push(controller);
      if (existing) this.api.updatePlatformAccessories([accessory]);
      else this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      controller.start();
    }
    // Invalid configuration returns before pruning. Connectivity never removes accessories.
    if (Array.isArray(this.config.devices)) {
      const removed = [...this.cached.values()].filter(accessory => !active.has(accessory.UUID));
      if (removed.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removed);
    }
    if (!parsed.devices.length) this.log.info('No devices configured. Open plugin settings to sign in to Xiaomi or add an IP address and token.');
  }
}
