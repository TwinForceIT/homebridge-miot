import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const SESSION_DURATION_MS = 15 * 60 * 1000;

export class SetupError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Owns one short-lived login. Account cookies never enter config or the browser. */
export class CloudSession {
  #session;
  #timer;

  constructor({ createClient, regions, isSupportedModel, now = Date.now }) {
    this.createClient = createClient;
    this.regions = regions;
    this.isSupportedModel = isSupportedModel;
    this.now = now;
  }

  async start(region) {
    if (!this.regions.includes(region)) throw new SetupError('INVALID_REGION');
    this.reset();
    const session = {
      id: randomUUID(),
      client: this.createClient(),
      region,
      expiresAt: this.now() + SESSION_DURATION_MS,
      authenticated: false,
      devices: new Map(),
    };
    this.#session = session;
    this.#timer = setTimeout(() => this.reset(session.id), SESSION_DURATION_MS);
    this.#timer.unref();
    try {
      const qr = await session.client.startQrLogin();
      this.#get(session.id);
      return { sessionId: session.id, ...qr };
    } catch (error) {
      this.reset(session.id);
      throw error;
    }
  }

  async poll(sessionId) {
    const session = this.#get(sessionId);
    if (session.authenticated) return { status: 'authenticated' };
    const status = await session.client.pollQrLogin();
    this.#get(sessionId);
    if (status === 'authenticated') session.authenticated = true;
    if (status === 'expired') this.reset(sessionId);
    return { status };
  }

  async devices(sessionId) {
    const session = this.#get(sessionId, true);
    const devices = await session.client.getDevices(session.region);
    this.#get(sessionId, true);
    session.devices = new Map(devices.map((device) => [device.did, device]));
    return [...session.devices.values()].map((device) => {
      const reason = this.#reason(device);
      return {
        did: device.did,
        name: device.name,
        model: device.model,
        host: device.localip,
        isOnline: device.isOnline,
        supported: this.isSupportedModel(device.model),
        canImport: reason === undefined,
        reason,
      };
    });
  }

  select(sessionId, dids) {
    const session = this.#get(sessionId, true);
    if (!Array.isArray(dids) || dids.length === 0 || dids.length > 1000
      || dids.some((did) => typeof did !== 'string')) {
      throw new SetupError('INVALID_SELECTION');
    }
    return [...new Set(dids)].map((did) => {
      const device = session.devices.get(did);
      if (!device || this.#reason(device)) throw new SetupError('INVALID_SELECTION');
      return {
        name: (device.name.trim() || 'Xiaomi Air Purifier').slice(0, 64),
        model: device.model,
        host: device.localip,
        token: device.token.toLowerCase(),
        did: device.did,
        enabled: true,
      };
    });
  }

  reset(sessionId) {
    if (sessionId !== undefined && this.#session?.id !== sessionId) return;
    clearTimeout(this.#timer);
    this.#session?.client.reset();
    this.#session = undefined;
  }

  #get(sessionId, authenticated = false) {
    if (!this.#session || this.#session.id !== sessionId) throw new SetupError('SESSION_EXPIRED');
    if (this.now() >= this.#session.expiresAt) {
      this.reset();
      throw new SetupError('SESSION_EXPIRED');
    }
    if (authenticated && !this.#session.authenticated) throw new SetupError('AUTH_REQUIRED');
    return this.#session;
  }

  #reason(device) {
    if (!this.isSupportedModel(device.model)) return 'UNSUPPORTED_MODEL';
    if (isIP(device.localip || '') !== 4) return 'MISSING_IP';
    if (!/^[a-f\d]{32}$/i.test(device.token || '') || /^0{32}$/.test(device.token)) return 'MISSING_TOKEN';
    return undefined;
  }
}
