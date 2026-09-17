import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { CloudError, XiaomiCloudClient, XIAOMI_REGIONS } from '../dist/cloud/index.js';
import { isSupportedModel } from '../dist/devices/registry.js';
import { CloudSession, SetupError } from './cloud-session.js';

const errorMessages = {
  INVALID_REGION: 'Wybierz region używany w aplikacji Xiaomi Home.',
  SESSION_EXPIRED: 'Sesja wygasła. Zaloguj się ponownie.',
  INVALID_SELECTION: 'Wybierz obsługiwane urządzenia z poprawnym adresem IP i tokenem.',
  AUTH_REQUIRED: 'Najpierw zaloguj się do Xiaomi.',
  AUTH_EXPIRED: 'Sesja Xiaomi wygasła. Zaloguj się ponownie.',
  NETWORK: 'Nie udało się połączyć z Xiaomi. Sprawdź połączenie i spróbuj ponownie.',
  LOGIN_REJECTED: 'Xiaomi nie zatwierdziło logowania. Wygeneruj nowy kod QR.',
  INVALID_RESPONSE: 'Xiaomi zwróciło nieoczekiwaną odpowiedź. Spróbuj ponownie później.',
  API_ERROR: 'Nie udało się pobrać urządzeń. Sprawdź wybrany region i spróbuj ponownie.',
  UNSAFE_URL: 'Xiaomi zwróciło nieprawidłowy adres logowania.',
  BUSY: 'Poprzednie żądanie jeszcze trwa. Spróbuj ponownie za chwilę.',
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
        throw new RequestError(errorMessages[code] || 'Operacja nie powiodła się. Spróbuj ponownie.', { code });
      }
    });
  }
}

new XiaomiMiotUiServer();
