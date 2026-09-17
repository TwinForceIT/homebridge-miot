import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { CloudError, XiaomiCloudClient, XIAOMI_REGIONS } from '../dist/cloud/index.js';
import { isSupportedModel } from '../dist/devices/registry.js';
import { CloudSession, SetupError } from './cloud-session.js';

const errorMessages = {
  INVALID_REGION: 'Select the region used in Xiaomi Home.',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
  INVALID_SELECTION: 'Select supported devices with a valid IP address and token.',
  AUTH_REQUIRED: 'Sign in to Xiaomi first.',
  AUTH_EXPIRED: 'Your Xiaomi session has expired. Please sign in again.',
  NETWORK: 'Could not connect to Xiaomi. Check your connection and try again.',
  LOGIN_REJECTED: 'Xiaomi did not approve the sign-in. Generate a new QR code.',
  INVALID_RESPONSE: 'Xiaomi returned an unexpected response. Please try again later.',
  API_ERROR: 'Could not load devices. Check the selected region and try again.',
  UNSAFE_URL: 'Xiaomi returned an invalid sign-in address.',
  BUSY: 'The previous request is still running. Please try again shortly.',
};

class XiaomiMiotUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.session = new CloudSession({
      createClient: () => new XiaomiCloudClient(),
      regions: XIAOMI_REGIONS,
      isSupportedModel,
    });
    this.route('/cloud/start', (body) => this.session.start(body?.region));
    this.route('/cloud/poll', (body) => this.session.poll(body?.sessionId));
    this.route('/cloud/devices', (body) => this.session.devices(body?.sessionId));
    this.route('/cloud/import', (body) => this.session.select(body?.sessionId, body?.dids));
    this.route('/cloud/logout', (body) => {
      this.session.reset(body?.sessionId);
      return { ok: true };
    });
    process.once('disconnect', () => this.session.reset());
    this.ready();
  }

  route(path, handler) {
    this.onRequest(path, async (body) => {
      try {
        return await handler(body);
      } catch (error) {
        // Never forward raw exceptions, request URLs, cookies, or tokens to logs/UI.
        const code = error instanceof CloudError || error instanceof SetupError ? error.code : 'UNKNOWN';
        throw new RequestError(errorMessages[code] || 'Something went wrong. Please try again.', { code });
      }
    });
  }
}

new XiaomiMiotUiServer();
