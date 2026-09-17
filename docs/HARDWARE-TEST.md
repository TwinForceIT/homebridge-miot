# Hardware acceptance testing

This checklist covers behavior that automated tests cannot confirm. Current status: **testing with physical devices and a real Xiaomi account has not been completed**.

Record the Homebridge, Node.js, and iOS versions, the MIoT model identifier, and the device firmware version. Do not include device tokens or an unredacted configuration in an issue.

## Air Purifier 4 Compact

1. **Login:** choose the correct region, generate a QR code, and approve it in Xiaomi Home. Check expired QR codes and cancellation. If extra account verification is requested, the account should remain logged out and the UI should show a useful message.
2. **Import:** inspect the device list, select CPA4, save, and restart Homebridge. Unsupported models should be visible but unavailable for import. Ending the session must not remove the saved configuration.
3. **Services:** Apple Home should show an air purifier. Check the linked air quality sensor and filter information in accessory details. If that version of Apple Home hides a standard characteristic, inspect it with another HAP client.
4. **Initial state:** compare values with Xiaomi Home. A powered-off or unreachable device must not display invented readings.
5. **Controls:** test power on/off, Auto, Manual, minimum/intermediate/maximum speed, 0%, and the physical button lock. Moving the slider above 0 should select Favorite and turn the purifier on.
6. **External changes:** change the mode and power in Xiaomi Home or with the device buttons. Check that the next polling cycle updates HomeKit. Sleep should appear as Manual, without an additional switch.
7. **Filter and air:** compare remaining filter life and PM2.5 readings. Do not reset the filter just for this test. The replacement indication at 0% is tested automatically with simulated data.
8. **Lost connection:** unplug the purifier and wait for a polling cycle. Apple Home should report no response, and logs should describe the failure without disclosing the token. Reconnect it and check recovery without pairing again.
9. **Faults:** do not deliberately damage the device. If it already reports a fault, compare its code with the log. Motor and sensor faults, fault clearance, and unknown codes are covered by simulation.
10. **Identity:** restart Homebridge and confirm that room assignments and automations remain. Importing a manual entry at the same IP must not create a duplicate. When changing the IP, preserve `id`/`did` and set the correct new address.
11. **Operation without the cloud:** after saving the configuration, end the Xiaomi session. Check control after restarting Homebridge without logging in again.
12. **Extended run:** observe several hours of operation, response to changes, and any purifier restarts. Record delays or rejected property reads with SIID/PIID and response codes, excluding secrets.

## Robot Vacuum E10

Also record the Apple home hub version, whether the plugin runs on the main bridge or a child bridge, and the Matter networking setup. Confirm the model is `xiaomi.vacuum.b112`.

1. **Setup and pairing:** enable Matter on the bridge running Xiaomi MIoT, import or manually add the E10, and restart. Pair the robot's own Matter QR code or PIN with Apple Home. Confirm that it appears as a robot vacuum and that an existing purifier still works through HomeKit without duplicate accessories.
2. **Initial readings:** compare activity, cleaning mode, battery percentage, and charging state with Xiaomi Home. Before the first valid response, the plugin should report unavailable operation and unknown battery instead of invented healthy state.
3. **Start, pause, and resume:** start a cleaning cycle, pause, and resume. Confirm that Xiaomi's stop-sweeping action pauses this firmware in place, as expected from upstream integrations; this mapping has not yet been tested on physical E10 hardware. Compare reported state after each command with the robot and Xiaomi Home.
4. **Stop and dock:** test Stop/Idle and the native return-to-dock command. Both should send the E10 back to its charger. Check returning-to-dock and charging states as the robot progresses.
5. **Cleaning modes and presets:** while idle or charging without a fault, select Vacuum, Vacuum and mop, and Mop, with the appropriate attachments and water preparation required by Xiaomi. Test suction presets 1–4 and water presets 1–3 for the relevant cleaning tasks. Compare settings with Xiaomi Home; a suction preset must preserve water, a water preset must preserve suction, and a base task must preserve both. Attempt a mode change while cleaning or paused and confirm that it is rejected without changing the robot's mode.
6. **External changes:** change activity, mode, suction, or water settings using Xiaomi Home and the physical buttons where available. Confirm that the next polling cycle updates Apple Home. A selected native preset should remain selected while its named settings match the robot, and fall back to the base task when those settings change externally.
7. **Battery:** compare the reported battery percentage while cleaning and charging. Low-battery thresholds and percentage conversion are covered by automated tests; do not deliberately deep-discharge the battery for this check.
8. **Identify:** where the controller offers an Identify function, trigger it and confirm that the robot makes its location sound. Canceling identification must not start a second sound.
9. **Faults and consumables:** if the robot already has a fault, compare the numeric Xiaomi error with the native operational error and Homebridge log. Do not create a jam or damage the robot for testing. Consumable replacement reminders at 0% are covered with simulated data; do not reset wear counters solely for this test.
10. **Lost connection:** temporarily make the robot unreachable. The plugin should report an operational error, clear the battery reading, and fail new commands. An Apple Home “No Response” badge is not guaranteed by the current Homebridge Matter API. Restore connectivity and check that current state returns without pairing again.
11. **Identity and lifecycle:** restart Homebridge and recreate the Docker container while retaining `/homebridge`, including Homebridge's Matter storage and `xiaomi-miot-matter-identities.json`. The robot's pairing, room assignment, and automations should remain. Preserve `id`/`did` when changing the LAN address. Disabling or deleting its configuration stops publication after a restart, but a separately paired robot may remain as an unavailable tile in Apple Home. Confirm that re-enabling the same entry preserves its identity. To remove the robot permanently, also remove its accessory in Apple Home. The plugin keeps inactive identity mappings without credentials.
12. **Operation without the cloud:** end the Xiaomi setup session and restart Homebridge. Confirm local control without signing in again.
13. **Extended run:** observe a complete cleaning and docking cycle and several hours of idle/charging updates. Record delayed states, rejected MIoT calls, or unexpected robot behavior with SIID/PIID/AIID and response codes, excluding secrets.

For a failed test, report the model, firmware, software versions, steps to reproduce, and a redacted log excerpt.
