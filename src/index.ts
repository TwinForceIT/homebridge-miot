import type { API } from 'homebridge';
import { XiaomiMiotPlatform } from './platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export default function register(api: API): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, XiaomiMiotPlatform);
}
