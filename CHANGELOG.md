# Changelog

## Unreleased

- Publish automatically after successful checks on every push or merge to `main`, using npm Trusted Publishing, automatic patch versions, queued releases, and idempotent retries.

- Explicitly clear stale Matter operational-error details when the robot recovers; nested state merging previously retained the old communication/fault description alongside NoError.
- Add background-refresh and live Matter endpoint diagnostics to Homebridge debug logs for investigating an Apple Home tile stuck on Updating; resolution of this Apple Home symptom still needs validation on an affected controller.
- Keep the polling timer scheduled after unexpected cycle failures and test six hours of passive polling, automatic recovery, and shutdown.
- Accept Xiaomi action acknowledgements that omit echoed service/action IDs, while checking any IDs supplied by the firmware.
- Accept pending MIoT command results and wait for delayed robot state updates before completing native Matter commands; mutations are never replayed.
- Share a three-second confirmation polling budget across a cleaning preset, polling only the changing properties.
- Preserve fresh activity and battery readings when a reachable robot rejects or does not confirm a command, instead of incorrectly reporting a communication failure.
- Add delayed-firmware regression coverage and exercise asynchronous commands through the real Homebridge Matter endpoint.

## 0.2.1

- Select the purifier's actual Sleep mode at 1% on the native speed slider; retain all 15 Favorite levels at 2–100% and preserve Sleep when HomeKit repeats Manual.
- Add optional display control for both CPA4 profiles using a linked native light with Off/Dim/On levels. It is disabled by default and changes only the display backlight.
- Report confirmed discrete slider values after writes and preserve display preferences during Xiaomi Cloud re-import.
- Accept repeated native cleaning settings without writing to the robot, including while physically paused or returning to dock.
- Preserve physical pause and docking when a Matter controller repeats the current run mode; native Resume continues to resume cleaning.
- Treat E10 code `2105` as a non-error indication based on a field report at full battery, while retaining raw readings and reporting all other unknown nonzero codes.
- Distinguish an actual setting change blocked by the current activity from a device fault, and include activity/battery context in fault warnings.
- Add regressions for physical state changes, repeated commands, fault recovery, and the real Homebridge Matter endpoint.

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
