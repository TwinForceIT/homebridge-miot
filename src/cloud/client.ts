import { createNonce, decryptResponse, encryptRequest } from './crypto.js';

// Protocol references (independent implementation, no upstream source vendored):
// https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor
// https://github.com/al-one/hass-xiaomi-miot/blob/master/custom_components/xiaomi_miot/core/xiaomi_cloud.py

export const XIAOMI_REGIONS = ['cn', 'de', 'us', 'ru', 'tw', 'sg', 'in', 'i2'] as const;
export type XiaomiRegion = typeof XIAOMI_REGIONS[number];
export type CloudErrorCode = 'NETWORK' | 'AUTH_EXPIRED' | 'AUTH_REQUIRED' | 'LOGIN_REJECTED'
  | 'INVALID_RESPONSE' | 'API_ERROR' | 'UNSAFE_URL' | 'BUSY';

/** Messages deliberately omit upstream bodies, URLs, cookies and credentials. */
export class CloudError extends Error {
  constructor(public readonly code: CloudErrorCode, message: string) {
    super(message);
    this.name = 'CloudError';
  }
}

export interface CloudDevice {
  did: string;
  name: string;
  model: string;
  localip: string;
  token: string;
  mac?: string;
  isOnline?: boolean;
}

export interface QrLogin {
  qrImageUrl: string;
  loginUrl: string;
  expiresAt: number;
}

interface Cookie { name: string; value: string; domain: string; hostOnly: boolean; path: string }
interface Credentials { userId: string; security: string; serviceToken: string }
type JsonObject = Record<string, unknown>;
const AGENT = 'Homebridge-MIOT APP/com.xiaomi.mihome APPV/10.5.201';

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CloudError('INVALID_RESPONSE', 'Xiaomi returned an unexpected response. Please try signing in again.');
  }
  return value as JsonObject;
}

function parseJson(text: string): JsonObject {
  try {
    return object(JSON.parse(text.replace(/^&&&START&&&/, '')));
  } catch {
    throw new CloudError('INVALID_RESPONSE', 'Xiaomi returned an unreadable response. Please try again.');
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function safeUrl(value: unknown, accountOnly = false): URL {
  let url: URL;
  try { url = new URL(String(value)); } catch {
    throw new CloudError('UNSAFE_URL', 'Xiaomi returned an invalid login address.');
  }
  const account = url.hostname === 'account.xiaomi.com' || url.hostname.endsWith('.account.xiaomi.com');
  const api = url.hostname === 'api.io.mi.com' || url.hostname.endsWith('.api.io.mi.com');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !(account || (!accountOnly && api))) {
    throw new CloudError('UNSAFE_URL', 'Xiaomi returned an untrusted login address.');
  }
  return url;
}

/** In-memory onboarding client. It never writes or logs cloud credentials. */
export class XiaomiCloudClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private cookies: Cookie[] = [];
  private credentials?: Credentials;
  private login?: QrLogin & { pollUrl: string };
  private session = new AbortController();
  private polling = false;

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  reset(): void {
    this.session.abort();
    this.session = new AbortController();
    this.cookies = [];
    this.credentials = undefined;
    this.login = undefined;
    this.polling = false;
  }

  async startQrLogin(): Promise<QrLogin> {
    this.reset();
    const session = this.session;
    const url = new URL('https://account.xiaomi.com/longPolling/loginUrl');
    url.search = new URLSearchParams({
      _qrsize: '480', qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      callback: 'https://sts.api.io.mi.com/sts', _hasLogo: 'false', sid: 'xiaomiio',
      serviceParam: '', _locale: 'en_GB', _dc: String(this.now()),
    }).toString();
    const response = await this.request(url, {}, 15_000, session);
    const data = parseJson(response.body);
    if (data.code !== undefined && data.code !== 0) {
      throw new CloudError('LOGIN_REJECTED', 'Xiaomi could not start QR sign-in. Please try again later.');
    }
    const timeout = typeof data.timeout === 'number' && data.timeout > 0 ? Math.min(data.timeout, 600) : 300;
    const login = {
      qrImageUrl: safeUrl(data.qr, true).href,
      loginUrl: safeUrl(data.loginUrl, true).href,
      expiresAt: this.now() + timeout * 1000,
    };
    if (session.signal.aborted) {
      throw new CloudError('AUTH_EXPIRED', 'The sign-in session was cancelled.');
    }
    this.login = { ...login, pollUrl: safeUrl(data.lp, true).href };
    return login;
  }

  async pollQrLogin(): Promise<'pending' | 'authenticated' | 'expired'> {
    if (this.credentials) { return 'authenticated'; }
    if (!this.login) { throw new CloudError('AUTH_REQUIRED', 'Start QR sign-in first.'); }
    if (this.now() >= this.login.expiresAt) { this.reset(); return 'expired'; }
    if (this.polling) { throw new CloudError('BUSY', 'A sign-in check is already running.'); }
    const session = this.session;
    const login = this.login;
    this.polling = true;
    try {
      const response = await this.request(new URL(login.pollUrl), {}, Math.min(12_000, login.expiresAt - this.now()), session, true);
      if (session.signal.aborted) { return 'expired'; }
      if (this.now() >= login.expiresAt) { this.reset(); return 'expired'; }
      if (response.status === 204 || response.status === 408 || response.body.trim() === '') { return 'pending'; }
      const data = parseJson(response.body);
      if (data.code !== undefined && data.code !== 0) {
        this.reset();
        throw new CloudError('LOGIN_REJECTED', 'Xiaomi declined or expired this QR login. Start a new sign-in and approve it in the Xiaomi app.');
      }
      if (data.notificationUrl) {
        this.reset();
        throw new CloudError('LOGIN_REJECTED', 'Complete account verification in the Xiaomi app, then start a new QR sign-in.');
      }
      const userId = text(data.userId);
      const security = text(data.ssecurity);
      if (!/^\d+$/.test(userId) || !/^[A-Za-z0-9+/]+={0,2}$/.test(security)) {
        throw new CloudError('INVALID_RESPONSE', 'Xiaomi did not provide the required login credentials. Start a new sign-in.');
      }
      await this.request(safeUrl(data.location), {}, 15_000, session);
      const serviceToken = this.cookies.find(cookie => cookie.name === 'serviceToken'
        && (cookie.domain === 'api.io.mi.com' || cookie.domain.endsWith('.api.io.mi.com')
          || 'api.io.mi.com'.endsWith(`.${cookie.domain}`)))?.value;
      if (!serviceToken) {
        throw new CloudError('INVALID_RESPONSE', 'Xiaomi did not complete sign-in. Please try again.');
      }
      if (session.signal.aborted) { return 'expired'; }
      this.credentials = { userId, security, serviceToken };
      this.login = undefined;
      return 'authenticated';
    } finally {
      if (session === this.session) { this.polling = false; }
    }
  }

  async getDevices(region: XiaomiRegion): Promise<CloudDevice[]> {
    if (!XIAOMI_REGIONS.includes(region)) {
      throw new CloudError('API_ERROR', 'Select a supported Xiaomi server region.');
    }
    if (!this.credentials) { throw new CloudError('AUTH_REQUIRED', 'Sign in to Xiaomi first.'); }
    const devices = new Map<string, CloudDevice>();
    const merge = (value: unknown): void => {
      if (!Array.isArray(value)) { throw new CloudError('INVALID_RESPONSE', 'Xiaomi returned an invalid device list.'); }
      for (const entry of value) {
        const device = object(entry);
        const did = text(device.did);
        if (!did || typeof device.model !== 'string') { continue; }
        const old = devices.get(did);
        devices.set(did, {
          did, model: device.model, name: text(device.name) || device.model,
          localip: text(device.localip ?? device.local_ip) || old?.localip || '',
          token: text(device.token) || old?.token || '',
          ...(typeof device.mac === 'string' ? { mac: device.mac } : {}),
          ...(typeof device.isOnline === 'boolean' ? { isOnline: device.isOnline } : {}),
        });
      }
    };
    // The broad list includes individually shared devices and devices outside a home.
    let broadError: unknown;
    try {
      const broad = await this.api(region, '/home/device_list', {
        getVirtualModel: true, getHuamiDevices: 1, get_split_device: false, support_smart_home: true,
      });
      merge(broad.list);
    } catch (error) {
      if (!(error instanceof CloudError) || error.code !== 'API_ERROR') { throw error; }
      broadError = error;
    }
    // The per-home list supplies current tokens and supports pagination for large homes.
    let homes: JsonObject;
    try {
      homes = await this.api(region, '/v2/homeroom/gethome_merged', {
        fg: true, fetch_share: true, fetch_share_dev: true, limit: 300, app_ver: 7,
      });
    } catch (error) {
      if (!(error instanceof CloudError) || error.code !== 'API_ERROR') { throw error; }
      homes = await this.api(region, '/v2/homeroom/gethome', {
        fg: true, fetch_share: true, fetch_share_dev: true, limit: 300, app_ver: 7,
      });
    }
    if (!Array.isArray(homes.homelist) || homes.has_more) {
      throw new CloudError('INVALID_RESPONSE', 'Xiaomi returned an incomplete home list. Please configure any missing devices manually.');
    }
    if (homes.homelist.length === 0 && broadError) { throw broadError; }
    for (const item of homes.homelist) {
      const home = object(item);
      const homeId = Number(home.id);
      const ownerId = Number(home.uid ?? this.credentials?.userId);
      if (!Number.isSafeInteger(homeId) || !Number.isSafeInteger(ownerId)) {
        throw new CloudError('INVALID_RESPONSE', 'Xiaomi returned an invalid home identifier.');
      }
      let cursor = '';
      const seen = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const result = await this.api(region, '/v2/home/home_device_list', {
          home_owner: ownerId, home_id: homeId, limit: 200, start_did: cursor,
          get_split_device: false, support_smart_home: true,
        });
        merge(result.device_info ?? []);
        if (!result.has_more) { break; }
        cursor = text(result.max_did);
        if (!cursor || seen.has(cursor) || page === 99) {
          throw new CloudError('INVALID_RESPONSE', 'Xiaomi returned an incomplete device list. Please try again.');
        }
        seen.add(cursor);
      }
    }
    return [...devices.values()];
  }

  private async api(region: XiaomiRegion, path: string, data: unknown): Promise<JsonObject> {
    const auth = this.credentials;
    if (!auth) { throw new CloudError('AUTH_REQUIRED', 'Sign in to Xiaomi first.'); }
    const { body, signedNonce } = encryptRequest(path, data, auth.security, createNonce(this.now()));
    const cookie = new URLSearchParams();
    for (const [name, value] of Object.entries({ userId: auth.userId, serviceToken: auth.serviceToken,
      yetAnotherServiceToken: auth.serviceToken, locale: 'en_GB', timezone: 'GMT+00:00',
      is_daylight: '0', dst_offset: '0', channel: 'MI_APP_STORE' })) { cookie.set(name, value); }
    const response = await this.request(new URL(`https://${region === 'cn' ? '' : `${region}.`}api.io.mi.com/app${path}`), {
      method: 'POST', body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        Cookie: [...cookie.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      },
    }, 20_000, this.session);
    const payload = response.body.trim();
    const result = parseJson(payload.startsWith('{') || payload.startsWith('&&&START&&&')
      ? payload : decryptResponse(payload, signedNonce));
    if ([2, 3, -3, -10001].includes(Number(result.code))) {
      this.reset();
      throw new CloudError('AUTH_EXPIRED', 'Your Xiaomi session expired. Please sign in again.');
    }
    if (result.code !== 0) {
      throw new CloudError('API_ERROR', `Xiaomi could not list devices${typeof result.code === 'number' ? ` (code ${result.code})` : ''}. Check the server region and try again.`);
    }
    return object(result.result);
  }

  private async request(url: URL, init: RequestInit, timeout: number, session: AbortController,
    allowPollTimeout = false): Promise<{ body: string; status: number }> {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(timeout)));
    const signal = AbortSignal.any([session.signal, timeoutSignal]);
    let target = safeUrl(url.href);
    for (let redirects = 0; redirects <= 5; redirects++) {
      try {
        const headers = new Headers(init.headers);
        headers.set('User-Agent', AGENT);
        headers.set('Accept-Encoding', 'identity');
        if (!headers.has('Cookie')) {
          headers.set('Cookie', this.cookies.filter(cookie =>
            (cookie.hostOnly ? target.hostname === cookie.domain
              : target.hostname === cookie.domain || target.hostname.endsWith(`.${cookie.domain}`))
            && (target.pathname === cookie.path || target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
            .map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
        }
        const response = await this.fetcher(target, { ...init, headers, redirect: 'manual', signal });
        if (session.signal.aborted) { throw new CloudError('AUTH_EXPIRED', 'The Xiaomi sign-in session was cancelled.'); }
        for (const line of response.headers.getSetCookie()) { this.captureCookie(target, line); }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || redirects === 5 || init.method === 'POST') {
            throw new CloudError('INVALID_RESPONSE', 'Xiaomi returned an unexpected redirect. Sign in again.');
          }
          target = safeUrl(new URL(location, target).href);
          await response.body?.cancel();
          continue;
        }
        if ([401, 403].includes(response.status)) {
          this.reset();
          throw new CloudError('AUTH_EXPIRED', 'Xiaomi denied this session. Please sign in again.');
        }
        if (!response.ok && !(allowPollTimeout && response.status === 408)) {
          throw new CloudError('NETWORK', `Xiaomi is unavailable (HTTP ${response.status}). Please try again.`);
        }
        const body = await response.text();
        if (session.signal.aborted) { throw new CloudError('AUTH_EXPIRED', 'The Xiaomi sign-in session was cancelled.'); }
        if (body.length > 5_000_000) { throw new CloudError('INVALID_RESPONSE', 'Xiaomi returned an oversized response.'); }
        return { body, status: response.status };
      } catch (error) {
        if (error instanceof CloudError) { throw error; }
        if (session.signal.aborted) { throw new CloudError('AUTH_EXPIRED', 'The Xiaomi sign-in session was cancelled.'); }
        if (allowPollTimeout && timeoutSignal.aborted) { return { body: '', status: 204 }; }
        throw new CloudError('NETWORK', 'Could not reach Xiaomi. Check the internet connection and try again.');
      }
    }
    throw new CloudError('INVALID_RESPONSE', 'Xiaomi returned too many redirects.');
  }

  private captureCookie(url: URL, line: string): void {
    const [pair = '', ...attributes] = line.split(';');
    const equals = pair.indexOf('=');
    if (equals < 1) { return; }
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    let domain = url.hostname;
    let hostOnly = true;
    let path = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/';
    let remove = !value;
    for (const attribute of attributes) {
      const [key = '', ...parts] = attribute.trim().split('=');
      const data = parts.join('=');
      if (key.toLowerCase() === 'domain') { domain = data.toLowerCase().replace(/^\./, ''); hostOnly = false; }
      if (key.toLowerCase() === 'path' && data.startsWith('/')) { path = data; }
      if (key.toLowerCase() === 'max-age' && Number(data) <= 0) { remove = true; }
      if (key.toLowerCase() === 'expires' && Date.parse(data) <= this.now()) { remove = true; }
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name) || /[\r\n;]/.test(value) || value.length > 8192
      || !(url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      || !['xiaomi.com', 'mi.com'].some(root => domain === root || domain.endsWith(`.${root}`))) { return; }
    this.cookies = this.cookies.filter(cookie => !(cookie.name === name && cookie.domain === domain && cookie.path === path));
    if (!remove) { this.cookies.push({ name, value, domain, hostOnly, path }); }
  }
}
