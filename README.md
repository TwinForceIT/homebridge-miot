# @twinforce/homebridge-miot

A modular Homebridge plugin for Xiaomi MIoT devices with native controls in Apple Home.

| Device | MIoT model | Apple Home integration |
| --- | --- | --- |
| Xiaomi Smart Air Purifier 4 Compact | `zhimi.airp.cpa4`, `xiaomi.airp.cpa4` | HomeKit Air Purifier, air quality, and filter maintenance |
| Xiaomi Robot Vacuum E10 | `xiaomi.vacuum.b112` | Matter Robotic Vacuum Cleaner |

The purifier uses standard HomeKit services. The E10 uses Homebridge's native Matter robot vacuum support, so Apple Home recognizes it as a robot vacuum. Neither device is represented by custom switches. Control is local through miIO/MIoT; Xiaomi Cloud is used only during setup.

**Validation status for 0.2.0:** covered by automated tests, checked against published MIoT specifications, and tested against the public QR login initiation endpoint. A complete login with a real Xiaomi account, control of physical devices, and presentation in Apple Home still require hardware testing. This project is not an Apple-certified accessory or an official Xiaomi integration.

## Air Purifier 4 Compact in Apple Home

| Feature | Native HomeKit mapping |
| --- | --- |
| Power | `AirPurifier.Active` |
| Automatic / manual control | `TargetAirPurifierState` — Auto / Manual |
| Current operation | `CurrentAirPurifierState` — inactive / idle / purifying |
| Speed | `RotationSpeed`, 0–100%; 15 levels in Xiaomi Favorite mode |
| Physical button lock | `LockPhysicalControls` |
| PM2.5 | `AirQualitySensor.PM2_5Density`, µg/m³ |
| Air quality category | `AirQuality` |
| Remaining filter life | `FilterMaintenance.FilterLifeLevel`, 0–100% |
| Filter replacement required | `FilterChangeIndication` at 0% |
| Fault | Standard `StatusFault` on the air quality service, with details in Homebridge logs |
| Lost connection | A HomeKit communication error instead of returning stale state as current |

Setting the speed above 0 turns the purifier on and selects Favorite mode, represented as Manual in HomeKit. A speed of 0 turns it off. The slider maps to Xiaomi's 15 levels, so the reported percentage may be rounded. In Auto, the displayed speed is an estimate based on motor RPM.

HomeKit has no standard Sleep mode for air purifiers. Sleep selected in Xiaomi Home is reported as Manual with the lowest slider position. Moving the slider selects Favorite. There is no separate Sleep switch.

HomeKit does not provide a text error list or a `StatusFault` characteristic directly on the AirPurifier service. Fault code 2 (motor), code 3 (dust sensor), and unknown codes are logged only when they change; fault clearance and connectivity recovery are also logged. A dust sensor fault reports unknown air quality and makes the PM2.5 reading return an error.

Apple Home's presentation depends on its version. Standard filter and fault characteristics may appear in accessory details or in other HomeKit clients. A separate text message or Apple push notification is not guaranteed. Reset the filter in Xiaomi Home or on the device; the plugin does not expose a reset action that could accidentally erase filter wear.

The `AirQuality` category is the plugin's display policy, using PM2.5 thresholds of 12 / 35 / 55 / 150 µg/m³. It is neither Xiaomi's calibrated AQI nor a health assessment. Unsupported temperature, humidity, and PM10 readings are not created.

## Robot Vacuum E10 in Apple Home

Apple Home's native robot vacuum support uses **Matter**. The E10 is published through Homebridge's Matter integration as a **Robotic Vacuum Cleaner**. It has its own pairing code and is not added through the purifier's HomeKit bridge pairing.

| Feature | Native Matter mapping |
| --- | --- |
| Start cleaning | `RvcRunMode` |
| Pause / resume | `RvcOperationalState` commands |
| Stop cleaning / return to dock | `RvcRunMode` Idle / `RvcOperationalState.GoHome` |
| Vacuum, vacuum and mop, or mop | `RvcCleanMode` |
| Suction and water levels | Native `RvcCleanMode` presets |
| Actual activity | `RvcOperationalState` — stopped, running, paused, returning to dock, charging, or error |
| Battery percentage and charging | `PowerSource` |
| Find the robot | Audible Matter `Identify` |
| Device fault | Native operational error, with the Xiaomi error code in Homebridge logs |
| Lost connection | Native operational error and unknown battery; commands fail until communication recovers |

**Pause is mapped to Xiaomi's stop-sweeping action, which upstream integrations use to pause in place; this behavior still needs confirmation on physical E10 hardware. Stop/Idle sends the return-to-dock action.** Start and Resume use the robot's start-cleaning action. State is read back from the robot rather than assumed from a command being accepted. Change the cleaning mode while the robot is idle or charging and has no fault; changes during cleaning, pause, return to dock, or a firmware update are rejected.

Only `xiaomi.vacuum.b112` is supported. Similar product names such as E10C or E10 variants with another MIoT identifier must not be assumed compatible. The published E10 specification supplies numeric fault codes without a complete description for each value, so the plugin preserves the code and reports a generic native fault rather than inventing a diagnosis. Apple Home decides how native modes, errors, and battery details are displayed. A communication failure is exposed as a native operational error; the Homebridge 2.4 API does not let this plugin guarantee an Apple Home “No Response” badge for the standalone robot.

The native cleaning-mode menu includes 17 choices:

| Choices | Settings changed |
| --- | --- |
| Vacuum / Vacuum and mop / Mop | Cleaning task only; existing suction and water settings are preserved |
| Vacuum: suction 1–4 | Vacuuming with the selected suction level |
| Vacuum and mop: suction 1–4 | Combined cleaning with the selected suction level; water is preserved |
| Mop: water 1–3 | Mopping with the selected water level |
| Vacuum and mop: water 1–3 | Combined cleaning with the selected water level; suction is preserved |

These are native cleaning modes, without additional switches or a simulated fan slider. Levels retain the numerical names from Xiaomi's specification. A selected preset remains reported only while the robot's actual settings match it; external changes can return the displayed selection to the corresponding base task. Apple Home may present a subset of native mode details, depending on its version.

Filter, brush, and mop life percentages remain in Xiaomi Home. The plugin logs a replacement reminder when a consumable reaches 0%, without resetting its wear. Room selection and maps are not exposed for this model.

### Enable Matter and pair the E10

1. Install the plugin, import the E10 from Xiaomi Cloud or add it manually, and save the configuration.
2. Enable Matter on the bridge running **Xiaomi MIoT**: use **Settings → Matter Settings** for the main bridge, or **Plugins → Xiaomi MIoT → Child Bridge Settings → Enable Matter** for a child bridge. Assign an available Matter port and restart that bridge. Keep HomeKit enabled for an existing purifier. See [Homebridge's Matter setup guide](https://github.com/homebridge-plugins/homebridge-matter/wiki/Enabling-Matter).
3. Find the **E10's own Matter pairing QR code or PIN** in Homebridge's Matter pairing information. In Apple Home, choose **Add Accessory** and scan that code. Robot vacuums receive a [separate pairing code](https://github.com/homebridge-plugins/homebridge-matter/wiki/Section-12-Robotic), so scanning the main bridge's QR code does not pair the robot.
4. Assign the robot to a room in Apple Home and test its native cleaning controls.

Matter must be enabled on the actual main or child bridge that runs this plugin. The plugin does not create a substitute HomeKit switch when Matter is disabled. Homebridge currently describes its Matter implementation as experimental; keep that in mind when upgrading Homebridge. Back up the Homebridge Matter storage together with `xiaomi-miot-matter-identities.json` in the Homebridge storage directory. This identity file contains no credentials and retains inactive mappings so re-enabling a device can reuse its pairing identity.

## Requirements

- Homebridge **2.4.0 or later in the 2.x series**; the current suite is tested with Homebridge **2.4.0** and HAP-NodeJS **2.2.2**.
- Node.js **22.12+**, **24**, or **26**; local tests use Node 22.23.1. CI covers all three major versions.
- A current Homebridge UI for guided setup, or manual editing of `config.json`.
- For the E10, Matter enabled in Homebridge and an Apple Home version supporting robot vacuums; Apple introduced this in [iOS 18.4](https://support.apple.com/en-us/121161). Keep your Apple devices and home hub up to date.
- For Matter, working IPv6 and local multicast discovery between Homebridge and Apple Home. Docker on Linux should use host networking; exposing only the web UI port is insufficient.
- Each device must already be paired with Xiaomi Home and reachable from Homebridge over UDP **54321**.
- A fixed IPv4 address or DHCP reservation. Container and VLAN networking must allow traffic to the device.
- Internet access during login and import. After a device is saved, runtime control does not depend on Xiaomi Cloud.

## Installation

The [@twinforce/homebridge-miot package](https://www.npmjs.com/package/@twinforce/homebridge-miot) is public on npmjs.org. Installation requires no npm account or token. The source repository also remains public on GitHub.

### Official Homebridge Docker image

For the `homebridge/homebridge` image, open **Terminal** in the Homebridge UI and run:

```sh
hb-service add @twinforce/homebridge-miot
```

Restart Homebridge from the UI, then open the **Xiaomi MIoT** plugin settings. The same installation can be performed from the Docker host; replace `homebridge` if your container has a different name:

```sh
docker exec -it homebridge hb-service add @twinforce/homebridge-miot
docker restart homebridge
```

Use the image's plugin manager so the plugin is installed in the directory Homebridge actually loads. Keep `/homebridge` on a persistent volume to retain plugins and configuration when recreating the container. The official Linux deployment uses host networking for discovery. See the [Homebridge Docker configuration](https://github.com/homebridge/docker-homebridge#configuration).

### Other Homebridge installations

Install the package through Homebridge UI when available. For a setup that loads plugins from the global npm directory, use the same Node.js environment as Homebridge:

```sh
npm install -g @twinforce/homebridge-miot
```

Restart Homebridge and open **Xiaomi MIoT** settings. If your installation manages plugins in a dedicated directory, use its plugin manager instead of installing into an unrelated global directory.

### Migrating from the earlier local package

If the unscoped `homebridge-miot` package is already installed, replace it with the `@twinforce` package. Stop Homebridge first. For a global npm installation:

```sh
npm uninstall -g homebridge-miot
npm install -g @twinforce/homebridge-miot
```

On a managed installation, remove the old plugin through its plugin manager and install the scoped package using the appropriate instructions above. Preserve configuration and accessory cache, then restart Homebridge.

Keep the `platform: "XiaomiMiot"` block and device identifiers. Homebridge 2 recognizes the unchanged platform name, and the plugin preserves existing accessory UUIDs. Do not load both packages together. Also update any `plugins`, `disabledPlugins`, or fully qualified platform names that refer to the old package name.

### Installing a local build

```sh
npm ci
npm run check
npm pack
```

Install the generated archive using the method appropriate for your Homebridge setup. For a global npm installation:

```sh
npm install -g /absolute/path/to/twinforce-homebridge-miot-VERSION.tgz
```

Replace `VERSION` with the generated filename and copy the archive to the Homebridge host if needed. In Docker, use the container's Homebridge environment and persistent plugin directory. Release instructions are in [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Setup through Xiaomi Cloud

1. In the plugin settings, choose the region used in Xiaomi Home; for Poland, this is usually **Europe (de)**.
2. Start Xiaomi login. Scan the QR code in Xiaomi Home and approve the login. A link to Xiaomi's login page is also available.
3. Select a supported device from the discovered list and save the selection.
4. Restart Homebridge. The purifier appears on the paired HomeKit bridge. For the E10, complete the separate Matter pairing described above.

The list includes unsupported models, but they cannot be imported. If Xiaomi does not return a local IP address or token, use manual configuration. Importing a device again updates its address and token while preserving its chosen name, stable identifier, and enabled state.

The plugin does not write account passwords, cookies, or sessions to disk. The setup session expires after 15 minutes and is cleared after import, logout, or closing the panel. Local device tokens are stored as plain text in `config.json`, like other Homebridge secrets; consider this when sharing configurations or backups. Tokens are neither logged nor stored in the accessory cache.

Xiaomi can change its undocumented login flow and token availability. If additional account verification is requested, complete it in Xiaomi Home and start a new login. Manual configuration remains independent of this flow.

## Manual configuration

Use the manual configuration option in the plugin settings, or add a block to the `platforms` array in your existing Homebridge configuration:

```json
{
  "platform": "XiaomiMiot",
  "name": "Xiaomi MIoT",
  "pollInterval": 15,
  "devices": [
    {
      "name": "Living room purifier",
      "model": "zhimi.airp.cpa4",
      "host": "192.168.1.50",
      "token": "0123456789abcdef0123456789abcdef",
      "id": "living-room-purifier",
      "enabled": true
    },
    {
      "name": "Robot vacuum",
      "model": "xiaomi.vacuum.b112",
      "host": "192.168.1.51",
      "token": "abcdef0123456789abcdef0123456789",
      "id": "robot-vacuum-e10",
      "enabled": true
    }
  ]
}
```

Both tokens above are examples. Supply each device's own 32-character LAN token, which is different from your Xiaomi account password. Use the device's actual model identifier. The E10 entry also requires Matter to be enabled and paired as described above.

- `pollInterval`: 10–300 seconds, default 15. Each polling cycle starts after the previous cycle completes.
- `id`: an optional stable identifier of your choice. Set it when first configuring a device manually and keep it when changing the IP address.
- `did`: Xiaomi's device identifier, populated during import. Without `id` or `did`, accessory identity depends on the IP address.
- `enabled: false`: stops publishing the device after a restart while retaining its configuration entry. A HomeKit purifier is removed from its bridge; a separately paired Matter robot may remain as an unavailable tile in Apple Home.

Importing an existing manually configured device at the same address preserves its accessory identity. A device that stops responding is not removed. Deleting its entry or disabling it stops publication after a restart and may affect automations. To permanently remove a separately paired E10, also remove its accessory in Apple Home. The plugin retains its identity mapping to support re-enabling the same device; preserve that file and Homebridge's Matter storage in backups.

## Architecture and development

- `src/platform.ts`: Homebridge lifecycle, accessory restoration, and reconciliation.
- `src/config.ts`: configuration validation and stable device identity.
- `src/devices/registry.ts`: registry of device families and their HomeKit or Matter adapters.
- `src/devices/profiles.ts`: CPA4 protocol definitions, including property addresses, ranges, and fault codes.
- `src/devices/purifier.ts`: purifier logic, command queue, polling, and write confirmation.
- `src/devices/vacuum-profile.ts` and `src/devices/vacuum.ts`: E10 MIoT properties, actions, and state validation.
- `src/matter/vacuum-accessory.ts`: the native Matter robot vacuum adapter.
- `src/matter/vacuum-modes.ts`: native cleaning presets and their mapping to actual device settings.
- `src/matter/identity-store.ts`: persistent Matter identity tracking and accessory reconciliation.
- `src/homekit/purifier-accessory.ts`: mapping to standard HAP services.
- `src/miio/`: independent UDP transport, encryption, response validation, and timeouts.
- `src/cloud/`: temporary login and device discovery, independent of the Homebridge platform.
- `homebridge-ui/`: setup UI and isolated import session.

To add a device family, implement a profile/controller and a native accessory adapter, register it in `registry.ts`, and update the model list in the configuration schema. Keep device-specific logic out of the platform and transport. Use native services appropriate to the device's actual functions.

CPA4 properties are read one at a time because of reported firmware problems with grouped reads. Reads and writes are queued; writes are confirmed by reading back state. Reads may be retried after a new handshake. A write whose reply is lost is not automatically repeated.

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Tests cover real HAP classes, a simulated UDP device, cryptographic vectors, failures and recovery, import, session expiry, and stable identity. Vacuum tests cover MIoT commands, authoritative state reads, native Matter controls, faults, battery, and accessory lifecycle. They do not replace testing with physical devices. See [docs/HARDWARE-TEST.md](docs/HARDWARE-TEST.md) for the acceptance checklist.

## Technical references

- [Xiaomi Robot Vacuum E10 MIoT specification](https://miot-spec.org/miot-spec-v2/instance?type=urn:miot-spec-v2:device:vacuum:0000A006:xiaomi-b112:1)
- [Homebridge native Matter robot vacuums](https://github.com/homebridge-plugins/homebridge-matter/wiki/Section-12-Robotic)
- [Homebridge Matter setup](https://github.com/homebridge-plugins/homebridge-matter/wiki/Enabling-Matter)
- [Apple Home robot vacuum support in iOS 18.4](https://support.apple.com/en-us/121161)
- [Xiaomi CPA4 v2 specification](https://miot-spec.org/miot-spec-v2/instance?type=urn:miot-spec-v2:device:air-purifier:0000A007:xiaomi-cpa4:2)
- [Zhimi CPA4 v1 specification](https://miot-spec.org/miot-spec-v2/instance?type=urn:miot-spec-v2:device:air-purifier:0000A007:zhimi-cpa4:1)
- [HAP-NodeJS standard service definitions](https://github.com/homebridge/HAP-NodeJS/blob/latest/src/lib/definitions/ServiceDefinitions.ts)
- [Homebridge 2 requirements](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0)
- [Homebridge Plugin UI Utils](https://github.com/homebridge/plugin-ui-utils)
- [Homebridge Docker](https://github.com/homebridge/docker-homebridge)
- [Homebridge service plugin management](https://github.com/homebridge/homebridge-config-ui-x/blob/latest/src/bin/hb-service.ts)
- [Reference miIO protocol implementation](https://github.com/rytilahti/python-miio/blob/master/miio/protocol.py)
- [Reference Xiaomi QR login and token extraction](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor)
- [Reference Xiaomi Cloud and home list API](https://github.com/al-one/hass-xiaomi-miot/blob/master/custom_components/xiaomi_miot/core/xiaomi_cloud.py)
