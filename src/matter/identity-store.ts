import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface MatterIdentity {
  UUID: string;
  context: { identity: string; model: string };
}

/** Homebridge does not restore external Matter accessories through the platform cache.
 * Persist identity only, never credentials or a device's potentially stale live state.
 */
export class MatterIdentityStore {
  private readonly path: string;
  constructor(storagePath: string) {
    this.path = join(storagePath, 'xiaomi-miot-matter-identities.json');
  }
  async load(): Promise<Map<string, MatterIdentity>> {
    let contents: string;
    try { contents = await readFile(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw new Error('Could not read saved Matter device identities. Check Homebridge storage permissions.');
    }
    try {
      const data: unknown = JSON.parse(contents);
      if (!record(data) || data.version !== 1 || !Array.isArray(data.devices)) throw new Error();
      const result = new Map<string, MatterIdentity>();
      for (const item of data.devices) {
        if (!record(item) || typeof item.UUID !== 'string' || !item.UUID || item.UUID.length > 128
          || !record(item.context) || typeof item.context.identity !== 'string' || !item.context.identity
          || item.context.identity.length > 256 || typeof item.context.model !== 'string' || !item.context.model
          || item.context.model.length > 128 || result.has(item.UUID)) throw new Error();
        result.set(item.UUID, { UUID: item.UUID, context: { identity: item.context.identity, model: item.context.model } });
      }
      return result;
    } catch {
      // Silently discarding this file could create a second accessory and lose pairing.
      throw new Error('Saved Matter device identities are invalid. Restore xiaomi-miot-matter-identities.json from a Homebridge backup.');
    }
  }
  async save(identities: ReadonlyMap<string, MatterIdentity>): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const devices = [...identities.values()].map(item => ({
      UUID: item.UUID,
      context: { identity: item.context.identity, model: item.context.model },
    }));
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, devices }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } catch {
      throw new Error('Could not save Matter device identities. Check Homebridge storage permissions before pairing.');
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
