import { isIP } from 'node:net';
import { isSupportedModel } from './devices/registry.js';
import { isSupportedModel as isPurifierModel } from './devices/profiles.js';

export interface DeviceConfig {
  name: string;
  model: string;
  host: string;
  token: string;
  did?: string;
  id?: string;
  enabled?: boolean;
  exposeDisplay?: boolean;
}
export interface ParsedConfig {
  devices: DeviceConfig[];
  pollInterval: number;
}
export function deviceIdentity(device: DeviceConfig): string {
  return device.id ? `id:${device.id}` : device.did ? `did:${device.did}` : `host:${device.host}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parseConfig(input: unknown): ParsedConfig {
  if (!record(input)) throw new Error('Configuration must be an object.');
  const pollInterval = input.pollInterval ?? 15;
  if (typeof pollInterval !== 'number' || !Number.isFinite(pollInterval) || pollInterval < 10 || pollInterval > 300) {
    throw new Error('pollInterval must be between 10 and 300 seconds.');
  }
  if (input.devices !== undefined && !Array.isArray(input.devices)) throw new Error('devices must be a list.');
  const devices: DeviceConfig[] = [];
  const identities = new Set<string>();
  const hosts = new Set<string>();
  const cloudIds = new Set<string>();
  for (const [index, value] of (input.devices ?? []).entries()) {
    const label = `Device ${index + 1}`;
    if (!record(value)) throw new Error(`${label}: invalid device configuration.`);
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error(`${label}: enabled must be true or false.`);
    if (value.enabled === false) continue;
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 64) throw new Error(`${label}: a name of 1–64 characters is required.`);
    if (typeof value.host !== 'string' || isIP(value.host) !== 4) throw new Error(`${label}: a valid IPv4 address is required.`);
    if (typeof value.token !== 'string' || !/^[a-f0-9]{32}$/i.test(value.token)) throw new Error(`${label}: token must contain 32 hexadecimal characters.`);
    if (typeof value.model !== 'string' || !isSupportedModel(value.model)) throw new Error(`${label}: unsupported model. Select a supported Xiaomi device profile.`);
    for (const key of ['id', 'did'] as const) {
      if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 128)) {
        throw new Error(`${label}: ${key} must be a string of up to 128 characters.`);
      }
    }
    if (value.exposeDisplay !== undefined && typeof value.exposeDisplay !== 'boolean') throw new Error(`${label}: exposeDisplay must be true or false.`);
    if (value.exposeDisplay === true && !isPurifierModel(value.model)) throw new Error(`${label}: display control is supported only for air purifiers.`);
    const device: DeviceConfig = {
      name: value.name.trim(), host: value.host, model: value.model, token: value.token.toLowerCase(),
      ...(typeof value.exposeDisplay === 'boolean' ? { exposeDisplay: value.exposeDisplay } : {}),
      ...(typeof value.id === 'string' && value.id.trim() ? { id: value.id.trim() } : {}),
      ...(typeof value.did === 'string' && value.did.trim() ? { did: value.did.trim() } : {}),
    };
    const identity = deviceIdentity(device);
    if (identities.has(identity) || hosts.has(device.host) || (device.did && cloudIds.has(device.did))) throw new Error(`${label}: device is configured more than once (same identity or IP address).`);
    identities.add(identity);
    hosts.add(device.host);
    if (device.did) cloudIds.add(device.did);
    devices.push(device);
  }
  return { devices, pollInterval };
}
