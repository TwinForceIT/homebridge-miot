# Changelog

## 0.2.0

- Add Xiaomi Robot Vacuum E10 (`xiaomi.vacuum.b112`) as a native Matter Robotic Vacuum Cleaner in Apple Home, including cleaning, pause/resume, return to dock, battery, charging, identification, and operational errors.
- Expose vacuuming, mopping, and combined cleaning through native cleaning modes, including suction and water-level presets.
- Add Xiaomi Cloud discovery/import for the E10, manual local configuration, consumable replacement reminders in logs, and persistent Matter accessory identities.
- Translate documentation and the setup UI into English, with Docker installation and separate robot Matter pairing instructions.
- Require Homebridge 2.4.0 or later in the 2.x series. Matter must be enabled on the bridge running the plugin to use the E10.
- Retain the Air Purifier 4 Compact's native HomeKit integration and existing accessory identities.

E10 behavior is covered by automated tests and checked against its published MIoT specification. Physical-device and Apple Home acceptance testing remain pending; see [the hardware checklist](docs/HARDWARE-TEST.md).

## 0.1.0

- Initial public npm release as `@twinforce/homebridge-miot`.
- Add Air Purifier 4 Compact with native HomeKit purifier, air quality, and filter maintenance services.
- Add Xiaomi Cloud QR setup, device import, and manual local configuration.
