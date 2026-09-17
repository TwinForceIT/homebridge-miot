import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { API, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { XiaomiMiotPlatform } from '../src/platform.js';
import register from '../src/index.js';
import { getDeviceDefinition } from '../src/devices/registry.js';

const device = { name: 'Purifier', model: 'zhimi.airp.cpa4', host: '192.168.1.30', token: '00112233445566778899aabbccddeeff' };
const uuid = (value: string): string => createHash('sha256').update(value).digest('hex');
class Accessory {
  context: Record<string, unknown> = {};
  services: unknown[] = [];
  constructor(public displayName: string, public UUID: string) {}
}
function fixture(devices: unknown) {
  const events = new EventEmitter();
  const registered: PlatformAccessory[] = [];
  const registrations: { plugin: string; platform: string }[] = [];
  const removed: PlatformAccessory[] = [];
  const updated: PlatformAccessory[] = [];
  const logMessages: string[] = [];
  let started = 0;
  let stopped = 0;
  const definition = getDeviceDefinition(device.model)!;
  const creation = mock.method(definition, 'create', (...[_api, _log, _accessory, _config, transport]: Parameters<typeof definition.create>) => ({
    start: () => { started++; }, stop: () => { stopped++; transport.close(); },
  }));
  const api = Object.assign(events, {
    hap: { uuid: { generate: uuid }, Categories: { AIR_PURIFIER: 19 }, Service: { AccessoryInformation: { UUID: 'information' } } },
    platformAccessory: Accessory,
    registerPlatformAccessories: (plugin: string, platform: string, list: PlatformAccessory[]) => {
      registrations.push({ plugin, platform });
      registered.push(...list);
    },
    unregisterPlatformAccessories: (_plugin: string, _platform: string, list: PlatformAccessory[]) => removed.push(...list),
    updatePlatformAccessories: (list: PlatformAccessory[]) => updated.push(...list),
  }) as unknown as API;
  const log = { error: (message: string) => logMessages.push(message), info: (message: string) => logMessages.push(message) } as unknown as Logger;
  const platform = new XiaomiMiotPlatform(log, { platform: 'XiaomiMiot', devices } as PlatformConfig, api);
  return { platform, events, registered, registrations, removed, updated, logMessages, creation, get started() { return started; }, get stopped() { return stopped; } };
}
test('scoped package registers the existing Homebridge platform name', () => {
  const registrations: unknown[][] = [];
  register({ registerPlatform: (...args: unknown[]) => registrations.push(args) } as unknown as API);
  assert.deepEqual(registrations, [['@twinforce/homebridge-miot', 'XiaomiMiot', XiaomiMiotPlatform]]);
});

test('scoped package registers devices with their original HomeKit UUID and closes on shutdown', t => {
  const f = fixture([device]);
  t.after(() => f.creation.mock.restore());
  f.events.emit('didFinishLaunching');
  assert.equal(f.registered.length, 1);
  assert.deepEqual(f.registrations, [{ plugin: '@twinforce/homebridge-miot', platform: 'XiaomiMiot' }]);
  assert.equal(f.registered[0]?.UUID, uuid('homebridge-miot:host:192.168.1.30'));
  assert.equal(f.started, 1);
  assert.ok(!JSON.stringify(f.registered[0]?.context).includes(device.token));
  f.events.emit('shutdown');
  assert.equal(f.stopped, 1);
});
test('manual-to-cloud migration preserves HomeKit UUID across restart and changed IP', t => {
  const cached = new Accessory('Purifier', uuid('homebridge-miot:host:192.168.1.30')) as unknown as PlatformAccessory;
  const f = fixture([{ ...device, did: '12345' }]);
  f.platform.configureAccessory(cached);
  f.events.emit('didFinishLaunching');
  assert.deepEqual(f.updated, [cached]);
  assert.deepEqual(f.registered, []);
  assert.deepEqual(f.removed, []);
  assert.equal(cached.context.identity, 'did:12345');
  f.events.emit('shutdown');
  f.creation.mock.restore();
  const second = fixture([{ ...device, host: '192.168.1.40', did: '12345' }]);
  t.after(() => second.creation.mock.restore());
  second.platform.configureAccessory(cached);
  second.events.emit('didFinishLaunching');
  assert.deepEqual(second.updated, [cached]);
  assert.deepEqual(second.registered, []);
  second.events.emit('shutdown');
});
test('invalid config preserves cached accessories, deliberate empty config removes them', t => {
  const cached = new Accessory('Purifier', uuid('homebridge-miot:host:192.168.1.30')) as unknown as PlatformAccessory;
  const invalid = fixture([{ ...device, token: 'bad' }]);
  invalid.platform.configureAccessory(cached);
  invalid.events.emit('didFinishLaunching');
  assert.deepEqual(invalid.removed, []);
  assert.equal(invalid.logMessages.length, 1);
  invalid.creation.mock.restore();
  const empty = fixture([]);
  t.after(() => empty.creation.mock.restore());
  empty.platform.configureAccessory(cached);
  empty.events.emit('didFinishLaunching');
  assert.deepEqual(empty.removed, [cached]);
});

test('a migrated cloud device keeps its accessory when another device reuses the old IP', async t => {
  for (const cloudImport of [true, false]) {
    for (const newOccupantFirst of [true, false]) {
      await t.test(`${cloudImport ? 'cloud' : 'manual'} occupant, ${newOccupantFirst ? 'occupant' : 'original'} first`, sub => {
        const oldUuid = uuid('homebridge-miot:host:192.168.1.30');
        const cached = new Accessory('Original', oldUuid) as unknown as PlatformAccessory;
        cached.context = { identity: 'did:original', model: device.model };
        const original = { ...device, name: 'Original', host: '192.168.1.40', did: 'original' };
        const occupant = { ...device, name: 'New occupant', ...(cloudImport ? { did: 'occupant' } : {}) };
        const configuration = newOccupantFirst ? [occupant, original] : [original, occupant];
        const first = fixture(configuration);
        first.platform.configureAccessory(cached);
        first.events.emit('didFinishLaunching');
        assert.equal(first.started, 2);
        assert.deepEqual(first.updated, [cached]);
        assert.equal(first.registered.length, 1);
        assert.deepEqual(first.removed, []);
        const newAccessory = first.registered[0]!;
        assert.notEqual(newAccessory.UUID, cached.UUID);
        assert.equal(cached.context.identity, 'did:original');
        assert.equal(newAccessory.context.identity, cloudImport ? 'did:occupant' : 'host:192.168.1.30');
        if (!cloudImport) {
          assert.equal(newAccessory.UUID, uuid('homebridge-miot:host:192.168.1.30:replacement:1'));
        }
        first.events.emit('shutdown');
        assert.equal(first.stopped, 2);
        first.creation.mock.restore();

        // Both UUIDs must survive a restart, including the alternate UUID given
        // to a manual occupant whose usual host UUID is still used by Original.
        const next = fixture(configuration);
        sub.after(() => next.creation.mock.restore());
        next.platform.configureAccessory(cached);
        next.platform.configureAccessory(newAccessory);
        next.events.emit('didFinishLaunching');
        assert.deepEqual(next.registered, []);
        assert.deepEqual(next.removed, []);
        assert.equal(new Set(next.updated.map(item => item.UUID)).size, 2);
        assert.equal(cached.UUID, oldUuid);
        next.events.emit('shutdown');
      });
    }
  }
});

test('a later cloud import preserves a manual accessory that already needed an alternate UUID', t => {
  const cached = new Accessory('Original', uuid('homebridge-miot:host:192.168.1.30')) as unknown as PlatformAccessory;
  cached.context = { identity: 'did:original', model: device.model };
  const manual = new Accessory('New occupant', uuid('homebridge-miot:host:192.168.1.30:replacement:1')) as unknown as PlatformAccessory;
  manual.context = { identity: 'host:192.168.1.30', model: device.model };
  const f = fixture([
    { ...device, name: 'New occupant', did: 'occupant' },
    { ...device, name: 'Original', host: '192.168.1.40', did: 'original' },
  ]);
  t.after(() => f.creation.mock.restore());
  f.platform.configureAccessory(cached);
  f.platform.configureAccessory(manual);
  f.events.emit('didFinishLaunching');
  assert.deepEqual(f.registered, []);
  assert.deepEqual(f.updated, [manual, cached]);
  assert.equal(manual.context.identity, 'did:occupant');
  assert.equal(cached.context.identity, 'did:original');
  f.events.emit('shutdown');
});
