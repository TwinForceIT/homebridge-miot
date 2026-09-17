import type { API, Logger, MatterAccessory, PlatformAccessory } from 'homebridge';
import type { DeviceConfig } from '../config.js';
import type { MiotTransport } from '../miio/transport.js';
import { PurifierAccessory } from '../homekit/purifier-accessory.js';
import { VacuumAccessory } from '../matter/vacuum-accessory.js';
import { SUPPORTED_MODELS as PURIFIER_MODELS } from './profiles.js';
import { SUPPORTED_VACUUM_MODELS } from './vacuum-profile.js';

export interface AccessoryController { start(): void; stop(): void }
export interface MatterAccessoryController extends AccessoryController { readonly accessory: MatterAccessory }
export interface HapDeviceDefinition {
  readonly protocol: 'hap';
  readonly models: readonly string[];
  category(api: API): number;
  create(api: API, log: Logger, accessory: PlatformAccessory, config: DeviceConfig, transport: MiotTransport, pollInterval: number): AccessoryController;
}
export interface MatterDeviceDefinition {
  readonly protocol: 'matter';
  readonly models: readonly string[];
  create(api: API, log: Logger, uuid: string, config: DeviceConfig, transport: MiotTransport, pollInterval: number): MatterAccessoryController;
}
export type DeviceDefinition = HapDeviceDefinition | MatterDeviceDefinition;

// Each family chooses its native protocol; the platform never emulates switches.
const definitions: readonly DeviceDefinition[] = [{
  protocol: 'hap',
  models: PURIFIER_MODELS,
  category: api => api.hap.Categories.AIR_PURIFIER,
  create: (api, log, accessory, config, transport, pollInterval) =>
    new PurifierAccessory(api, log, accessory, config, transport, pollInterval),
}, {
  protocol: 'matter',
  models: SUPPORTED_VACUUM_MODELS,
  create: (api, log, uuid, config, transport, pollInterval) =>
    new VacuumAccessory(api, log, uuid, config, transport, pollInterval),
}];
export const SUPPORTED_MODELS = definitions.flatMap(definition => [...definition.models]);
export function getDeviceDefinition(model: string): DeviceDefinition | undefined {
  return definitions.find(definition => definition.models.includes(model));
}
export function isSupportedModel(model: string): boolean { return getDeviceDefinition(model) !== undefined; }
