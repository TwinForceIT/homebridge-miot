import type { API, Logger, PlatformAccessory } from 'homebridge';
import type { DeviceConfig } from '../config.js';
import type { MiotTransport } from '../miio/transport.js';
import { PurifierAccessory } from '../homekit/purifier-accessory.js';
import { SUPPORTED_MODELS as PURIFIER_MODELS } from './profiles.js';

export interface AccessoryController { start(): void; stop(): void }
export interface DeviceDefinition {
  readonly models: readonly string[];
  category(api: API): number;
  create(api: API, log: Logger, accessory: PlatformAccessory, config: DeviceConfig, transport: MiotTransport, pollInterval: number): AccessoryController;
}
// Add a device family here; platform discovery and transport stay unchanged.
const definitions: readonly DeviceDefinition[] = [{
  models: PURIFIER_MODELS,
  category: api => api.hap.Categories.AIR_PURIFIER,
  create: (api, log, accessory, config, transport, pollInterval) =>
    new PurifierAccessory(api, log, accessory, config, transport, pollInterval),
}];
export const SUPPORTED_MODELS = definitions.flatMap(definition => [...definition.models]);
export function getDeviceDefinition(model: string): DeviceDefinition | undefined {
  return definitions.find(definition => definition.models.includes(model));
}
export function isSupportedModel(model: string): boolean { return getDeviceDefinition(model) !== undefined; }
