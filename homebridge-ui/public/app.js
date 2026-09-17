import { mergeDevices } from './config.js';

const homebridge = window.homebridge;
const element = (id) => document.getElementById(id);
let sessionId;
let generation = 0;
let pollTimer;
let qrExpiresAt = 0;
let manualVisible = false;
let importing = false;

function feedback(message, kind = 'info') {
  const target = element('feedback');
  target.textContent = message;
  target.className = `alert alert-${kind}`;
  target.hidden = !message;
  if (kind === 'danger') target.setAttribute('role', 'alert');
  else target.setAttribute('role', 'status');
}

function showError(error) {
  const message = typeof error?.message === 'string' ? error.message : 'Something went wrong. Please try again.';
  feedback(message, 'danger');
}

function setManual(visible) {
  manualVisible = visible;
  element('manual-toggle').setAttribute('aria-expanded', String(visible));
  element('manual-toggle').textContent = visible ? 'Hide manual configuration' : 'Add manually or edit configuration';
  element('manual-help').hidden = !visible;
  if (visible) homebridge.showSchemaForm();
  else homebridge.hideSchemaForm();
}

async function renderConfigured() {
  const blocks = await homebridge.getPluginConfig();
  const devices = blocks.filter((block) => block.platform === 'XiaomiMiot')
    .flatMap((block) => Array.isArray(block.devices) ? block.devices : []);
  element('device-count').textContent = String(devices.length);
  element('configured-empty').hidden = devices.length > 0;
  const list = element('configured-list');
  list.replaceChildren();
  for (const device of devices) {
    const row = document.createElement('li');
    row.className = 'device-row';
    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = device.name || 'Xiaomi device';
    const detail = document.createElement('span');
    detail.className = 'device-details';
    detail.textContent = [device.model, device.host, device.enabled === false ? 'Disabled in configuration' : null].filter(Boolean).join(' · ');
    text.append(name, detail);
    row.append(text);
    list.append(row);
  }
}

function resetView() {
  clearTimeout(pollTimer);
  element('qr-panel').hidden = true;
  element('qr-image').removeAttribute('src');
  element('login-link').removeAttribute('href');
  element('cloud-results').hidden = true;
  element('cloud-list').replaceChildren();
  element('cancel').hidden = true;
  element('login').disabled = false;
  element('login').textContent = 'Sign in with Xiaomi';
  element('region').disabled = false;
  updateImportButton();
}

async function endSession(showMessage = false) {
  generation += 1;
  const previous = sessionId;
  sessionId = undefined;
  resetView();
  if (previous) {
    try { await homebridge.request('/cloud/logout', { sessionId: previous }); }
    catch { /* Closing the settings also terminates the isolated server process. */ }
  }
  if (showMessage) feedback('Signed out of Xiaomi. Your saved devices remain configured.');
}

function validLoginUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password
    || !(url.hostname === 'account.xiaomi.com' || url.hostname.endsWith('.account.xiaomi.com'))) {
    throw new Error('Invalid Xiaomi sign-in address.');
  }
  return url.href;
}

async function startLogin() {
  await endSession();
  const current = generation;
  feedback('');
  setManual(false);
  element('login').disabled = true;
  element('login').textContent = 'Preparing sign-in…';
  element('region').disabled = true;
  element('cancel').hidden = false;
  try {
    const result = await homebridge.request('/cloud/start', { region: element('region').value });
    if (current !== generation) {
      await homebridge.request('/cloud/logout', { sessionId: result.sessionId });
      return;
    }
    sessionId = result.sessionId;
    element('qr-image').src = validLoginUrl(result.qrImageUrl);
    element('login-link').href = validLoginUrl(result.loginUrl);
    qrExpiresAt = result.expiresAt;
    element('qr-panel').hidden = false;
    element('login-status').textContent = 'Waiting for confirmation…';
    element('login').textContent = 'Waiting for Xiaomi…';
    pollTimer = setTimeout(() => pollLogin(current), 1000);
  } catch (error) {
    if (current !== generation) return;
    await endSession();
    showError(error);
  }
}

async function pollLogin(current) {
  if (current !== generation || !sessionId) return;
  try {
    if (Number.isFinite(qrExpiresAt) && Date.now() >= qrExpiresAt) {
      throw new Error('The QR code has expired. Sign in again to get a new code.');
    }
    const result = await homebridge.request('/cloud/poll', { sessionId });
    if (current !== generation) return;
    if (result.status === 'authenticated') {
      element('qr-panel').hidden = true;
      element('qr-image').removeAttribute('src');
      element('login-link').removeAttribute('href');
      element('cancel').hidden = true;
      element('login').textContent = 'Connected to Xiaomi';
      element('cloud-results').hidden = false;
      await loadDevices(current);
      return;
    }
    if (result.status === 'expired') throw new Error('The QR code has expired. Please sign in again.');
    pollTimer = setTimeout(() => pollLogin(current), 1500);
  } catch (error) {
    if (current !== generation) return;
    await endSession();
    showError(error);
  }
}

const unavailableMessages = {
  UNSUPPORTED_MODEL: 'This model is not supported yet.',
  MISSING_IP: 'No local IPv4 address. Check the connection in Xiaomi Home or add the device manually.',
  MISSING_TOKEN: 'Xiaomi did not provide a local token. You can add the device manually.',
};

async function loadDevices(current = generation) {
  element('refresh').disabled = true;
  element('refresh').textContent = 'Loading…';
  element('import').disabled = true;
  feedback('Loading devices from the selected region…');
  try {
    const devices = await homebridge.request('/cloud/devices', { sessionId });
    if (current !== generation) return;
    const list = element('cloud-list');
    list.replaceChildren();
    element('cloud-empty').hidden = devices.length > 0;
    for (const device of devices) {
      const row = document.createElement('label');
      row.className = 'device-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = device.did;
      checkbox.disabled = !device.canImport;
      checkbox.addEventListener('change', updateImportButton);
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = device.name || 'Xiaomi device';
      const details = document.createElement('span');
      details.className = 'device-details';
      details.textContent = [device.model, device.host, device.isOnline === false ? 'Offline in Xiaomi Home' : null].filter(Boolean).join(' · ');
      text.append(name, details);
      if (!device.canImport) {
        const reason = document.createElement('span');
        reason.className = 'device-note';
        reason.textContent = unavailableMessages[device.reason] || 'This device cannot be added automatically.';
        text.append(reason);
      }
      row.append(checkbox, text);
      list.append(row);
    }
    feedback(devices.some((device) => device.canImport) ? 'Select the devices you want to add or update.' : '');
  } catch (error) {
    if (current === generation) showError(error);
  } finally {
    if (current === generation) {
      element('refresh').disabled = false;
      element('refresh').textContent = 'Refresh list';
      updateImportButton();
    }
  }
}

function selectedDids() {
  return [...element('cloud-list').querySelectorAll('input:checked')].map((input) => input.value);
}

function updateImportButton() {
  const count = selectedDids().length;
  element('import').disabled = importing || count === 0;
  element('import').textContent = importing ? 'Saving…' : `Add and save selected${count ? ` (${count})` : ''}`;
}

async function importDevices() {
  const dids = selectedDids();
  if (!dids.length || importing) return;
  importing = true;
  updateImportButton();
  element('refresh').disabled = true;
  element('logout').disabled = true;
  element('cloud-devices').disabled = true;
  try {
    const devices = await homebridge.request('/cloud/import', { sessionId, dids });
    // Fetch the latest draft so edits from Homebridge's native form are preserved.
    const blocks = await homebridge.getPluginConfig();
    await homebridge.updatePluginConfig(mergeDevices(blocks, devices));
    await homebridge.savePluginConfig();
    await renderConfigured();
    await endSession();
    const includesRobot = devices.some((device) => device.model === 'xiaomi.vacuum.b112');
    feedback(includesRobot
      ? 'Devices saved. Enable Matter on the bridge running this plugin, restart it, and add the E10 in Apple Home using the robot’s own Matter pairing code.'
      : 'Devices saved. Restart Homebridge to see them in Apple Home.', 'success');
  } catch (error) {
    showError(error);
  } finally {
    importing = false;
    element('refresh').disabled = false;
    element('logout').disabled = false;
    element('cloud-devices').disabled = false;
    updateImportButton();
  }
}

async function initialize() {
  element('login').addEventListener('click', startLogin);
  element('cancel').addEventListener('click', () => endSession());
  element('logout').addEventListener('click', () => endSession(true));
  element('refresh').addEventListener('click', () => loadDevices());
  element('import').addEventListener('click', importDevices);
  element('manual-toggle').addEventListener('click', () => setManual(!manualVisible));
  element('qr-image').addEventListener('error', () => {
    element('login-status').textContent = 'The QR code could not be displayed. Open the Xiaomi sign-in page below.';
  });
  homebridge.addEventListener('configChanged', () => { renderConfigured().catch(showError); });
  window.addEventListener('pagehide', () => {
    generation += 1;
    clearTimeout(pollTimer);
  });
  try {
    const blocks = await homebridge.getPluginConfig();
    if (blocks.length === 0) await homebridge.updatePluginConfig(mergeDevices([], []));
    await renderConfigured();
  } catch (error) { showError(error); }
}

initialize();
