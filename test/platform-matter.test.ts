import assert from 'node:assert/strict';
import { test, mock, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { API, Logger, MatterAccessory, PlatformAccessory, PlatformConfig } from 'homebridge';
import type { DeviceConfig } from '../src/config.js';
import { XiaomiMiotPlatform } from '../src/platform.js';
import { getDeviceDefinition } from '../src/devices/registry.js';
import { MatterIdentityStore } from '../src/matter/identity-store.js';

const vacuum = { name: 'Vacuum', model: 'xiaomi.vacuum.b112', host: '192.0.2.30', token: '00112233445566778899aabbccddeeff' };
const purifier = { ...vacuum, name: 'Purifier', model: 'zhimi.airp.cpa4', host: '192.0.2.31' };
const uuid = (value: string): string => createHash('sha256').update(value).digest('hex');

class HapAccessory {
  context: Record<string, unknown> = {};
  services: unknown[] = [];
  constructor(public displayName: string, public UUID: string) {}
}
interface Options {
  matter?: boolean;
  registration?: () => Promise<void>;
  state?: () => Promise<unknown>;
}

function fixture(t: TestContext, storagePath: string, devices: unknown, options: Options = {}) {
  const events = new EventEmitter();
  const hapRegistered: PlatformAccessory[] = [];
  const matterRegistered: MatterAccessory[] = [];
  const matterRemoved: MatterAccessory[] = [];
  const logMessages: string[] = [];
  const controllers: Array<{ UUID: string; started: number; stopped: number }> = [];
  const vacuumDefinition = getDeviceDefinition(vacuum.model)!;
  const purifierDefinition = getDeviceDefinition(purifier.model)!;
  if (vacuumDefinition.protocol !== 'matter' || purifierDefinition.protocol !== 'hap') throw new Error('Wrong native device protocol');
  const nativeCreation = mock.method(vacuumDefinition, 'create', (...[_api, _log, id, config, transport]: Parameters<typeof vacuumDefinition.create>) => {
    const counts = { UUID: id, started: 0, stopped: 0 };
    controllers.push(counts);
    return {
      accessory: { UUID: id, displayName: config.name, deviceType: 0x74, context: {}, clusters: {} },
      start: () => { counts.started++; },
      stop: () => { counts.stopped++; transport.close(); },
    };
  });
  let purifierStarted = 0;
  let purifierStopped = 0;
  const hapCreation = mock.method(purifierDefinition, 'create', (...[_api, _log, _accessory, _config, transport]: Parameters<typeof purifierDefinition.create>) => ({
    start: () => { purifierStarted++; },
    stop: () => { purifierStopped++; transport.close(); },
  }));
  t.after(() => { nativeCreation.mock.restore(); hapCreation.mock.restore(); });
  const api = Object.assign(events, {
    hap: { uuid: { generate: uuid }, Categories: { AIR_PURIFIER: 19 }, Service: { AccessoryInformation: { UUID: 'information' } } },
    user: { storagePath: () => storagePath },
    platformAccessory: HapAccessory,
    registerPlatformAccessories: (_plugin: string, _platform: string, list: PlatformAccessory[]) => hapRegistered.push(...list),
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
    ...(options.matter === false ? {} : { matter: {
      registerPlatformAccessories: async (plugin: string, platform: string, list: MatterAccessory[]) => {
        assert.equal(plugin, '@twinforce/homebridge-miot');
        assert.equal(platform, 'XiaomiMiot');
        matterRegistered.push(...list);
        await options.registration?.();
      },
      unregisterPlatformAccessories: async (_plugin: string, _platform: string, list: MatterAccessory[]) => { matterRemoved.push(...list); },
      getAccessoryState: async () => options.state ? options.state() : { currentMode: 0 },
    } }),
  }) as unknown as API;
  const log = { error: (message: string) => logMessages.push(message), info: (message: string) => logMessages.push(message) } as unknown as Logger;
  const platform = new XiaomiMiotPlatform(log, { platform: 'XiaomiMiot', devices } as PlatformConfig, api);
  // Observe completion of the async launch while exercising the real public
  // didFinishLaunching entry point, avoiding timing sleeps around filesystem I/O.
  const implementation = platform as unknown as { launchMatter(devices: DeviceConfig[], interval: number): Promise<void> };
  const original = implementation.launchMatter.bind(platform);
  let pending: Promise<void> = Promise.resolve();
  mock.method(implementation, 'launchMatter', (...args: Parameters<typeof original>) => { pending = original(...args); return pending; });
  return {
    platform, events, hapRegistered, matterRegistered, matterRemoved, logMessages, controllers,
    get purifierStarted() { return purifierStarted; }, get purifierStopped() { return purifierStopped; },
    launch: async () => { events.emit('didFinishLaunching'); await pending; },
    finished: () => pending,
    restore: () => { nativeCreation.mock.restore(); hapCreation.mock.restore(); },
  };
}

async function storage(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'xiaomi-miot-matter-platform-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('mixed devices use separate native HAP and Matter registrations with no credentials in either cache', async t => {
  const path = await storage(t);
  const f = fixture(t, path, [purifier, vacuum]);
  await f.launch();
  assert.equal(f.hapRegistered.length, 1);
  assert.equal(f.matterRegistered.length, 1);
  assert.equal(f.hapRegistered[0]?.displayName, 'Purifier');
  assert.equal(f.matterRegistered[0]?.displayName, 'Vacuum');
  assert.equal(f.controllers[0]?.started, 1);
  assert.equal(f.purifierStarted, 1);
  const contents = await readFile(join(path, 'xiaomi-miot-matter-identities.json'), 'utf8');
  assert.equal(contents.includes(vacuum.token), false);
  assert.deepEqual(JSON.parse(contents), { version: 1, devices: [{
    UUID: uuid('homebridge-miot:host:192.0.2.30'), context: { model: vacuum.model, identity: 'host:192.0.2.30' },
  }] });
  assert.equal(JSON.stringify(f.hapRegistered[0]?.context).includes(vacuum.token), false);
  assert.equal(JSON.stringify(f.matterRegistered[0]?.context).includes(vacuum.token), false);
  assert.equal((await stat(join(path, 'xiaomi-miot-matter-identities.json'))).mode & 0o777, 0o600);
  f.events.emit('shutdown');
  assert.equal(f.controllers[0]?.stopped, 1);
  assert.equal(f.purifierStopped, 1);
});

test('Matter disabled leaves the purifier operational and explains the vacuum requirement', async t => {
  const f = fixture(t, await storage(t), [vacuum, purifier], { matter: false });
  await f.launch();
  assert.equal(f.hapRegistered.length, 1);
  assert.equal(f.purifierStarted, 1);
  assert.equal(f.controllers.length, 0);
  assert.match(f.logMessages.join('\n'), /Matter enabled/);
  f.events.emit('shutdown');
});

test('external Matter UUID survives manual to cloud migration and changed IP with no Homebridge cache callback', async t => {
  const path = await storage(t);
  const manual = fixture(t, path, [vacuum]);
  await manual.launch();
  const originalUUID = manual.matterRegistered[0]!.UUID;
  manual.events.emit('shutdown');
  manual.restore();

  const cloud = fixture(t, path, [{ ...vacuum, did: '12345' }]);
  await cloud.launch();
  assert.equal(cloud.matterRegistered[0]?.UUID, originalUUID);
  assert.deepEqual(cloud.matterRegistered[0]?.context, { model: vacuum.model, identity: 'did:12345' });
  cloud.events.emit('shutdown');
  cloud.restore();

  const changedIp = fixture(t, path, [{ ...vacuum, did: '12345', host: '192.0.2.40' }]);
  await changedIp.launch();
  assert.equal(changedIp.matterRegistered[0]?.UUID, originalUUID);
  assert.equal((await new MatterIdentityStore(path).load()).get(originalUUID)?.context.identity, 'did:12345');
  changedIp.events.emit('shutdown');
});

test('a new vacuum at the old IP cannot take an existing cloud vacuum pairing', async t => {
  const path = await storage(t);
  const store = new MatterIdentityStore(path);
  const originalUUID = uuid('homebridge-miot:host:192.0.2.30');
  await store.save(new Map([[originalUUID, { UUID: originalUUID, context: { model: vacuum.model, identity: 'did:original' } }]]));
  const f = fixture(t, path, [vacuum, { ...vacuum, name: 'Original', host: '192.0.2.40', did: 'original' }]);
  await f.launch();
  const newcomer = f.matterRegistered.find(accessory => accessory.displayName === 'Vacuum')!;
  const original = f.matterRegistered.find(accessory => accessory.displayName === 'Original')!;
  assert.equal(original.UUID, originalUUID);
  assert.equal(newcomer.UUID, uuid('homebridge-miot:host:192.0.2.30:replacement:1'));
  f.events.emit('shutdown');
});

test('shutdown during external Matter registration never starts polling', async t => {
  const registering = gate();
  const release = gate();
  const f = fixture(t, await storage(t), [vacuum], { registration: async () => { registering.resolve(); await release.promise; } });
  const launched = f.launch();
  await registering.promise;
  f.events.emit('shutdown');
  release.resolve();
  await launched;
  assert.equal(f.controllers.length, 1);
  assert.equal(f.controllers[0]?.started, 0);
  assert.ok(f.controllers[0]!.stopped >= 1);
});

test('registration resolving without a published Matter endpoint stops the controller', async t => {
  const f = fixture(t, await storage(t), [vacuum], { state: async () => undefined });
  await f.launch();
  assert.equal(f.controllers.length, 1);
  assert.equal(f.controllers[0]?.started, 0);
  assert.equal(f.controllers[0]?.stopped, 1);
  assert.match(f.logMessages.join('\n'), /could not initialize the native Matter accessory/);
});

test('registration errors stop the vacuum controller but preserve its pairing identity and the purifier', async t => {
  const path = await storage(t);
  const f = fixture(t, path, [vacuum, purifier], { registration: async () => { throw new Error('Matter is disabled on this bridge'); } });
  await f.launch();
  assert.equal(f.purifierStarted, 1);
  assert.equal(f.controllers[0]?.started, 0);
  assert.equal(f.controllers[0]?.stopped, 1);
  assert.equal((await new MatterIdentityStore(path).load()).size, 1);
  f.events.emit('shutdown');
});

test('invalid persisted identities fail closed instead of silently generating a new pairing', async t => {
  const path = await storage(t);
  const damaged = '{"version":1,"devices":[{"UUID":"known","context":{"identity":"did:123"}}]}';
  await writeFile(join(path, 'xiaomi-miot-matter-identities.json'), damaged);
  const f = fixture(t, path, [vacuum, purifier]);
  await f.launch();
  assert.equal(f.purifierStarted, 1);
  assert.equal(f.controllers.length, 0);
  assert.equal(f.matterRegistered.length, 0);
  assert.match(f.logMessages.join('\n'), /Restore.*from a Homebridge backup/);
  assert.equal(await readFile(join(path, 'xiaomi-miot-matter-identities.json'), 'utf8'), damaged);
  f.events.emit('shutdown');
});

test('identity persistence strips unexpected fields and rejects duplicate UUIDs', async t => {
  const path = await storage(t);
  const store = new MatterIdentityStore(path);
  const identity = { UUID: 'known', context: { identity: 'did:123', model: vacuum.model, token: vacuum.token }, token: vacuum.token };
  await store.save(new Map([['known', identity]]));
  assert.equal((await readFile(join(path, 'xiaomi-miot-matter-identities.json'), 'utf8')).includes(vacuum.token), false);
  await writeFile(join(path, 'xiaomi-miot-matter-identities.json'), JSON.stringify({ version: 1, devices: [identity, identity] }));
  await assert.rejects(store.load(), /identities are invalid/);
});

test('shutdown while checking published state never starts polling after the check resolves', async t => {
  const checking = gate();
  const release = gate();
  const f = fixture(t, await storage(t), [vacuum], { state: async () => {
    checking.resolve();
    await release.promise;
    return { currentMode: 0 };
  } });
  const launched = f.launch();
  await checking.promise;
  f.events.emit('shutdown');
  release.resolve();
  await launched;
  assert.equal(f.controllers[0]?.started, 0);
  assert.ok(f.controllers[0]!.stopped >= 1);
});
