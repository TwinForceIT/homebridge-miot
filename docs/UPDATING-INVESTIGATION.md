# E10 Apple Home Updating investigation

## Field evidence (2026-09-18)

The affected installation ran Homebridge 2.4.0, Matter.js 0.17.9, and plugin 0.2.1. Apple Home showed Updating after the phone had been idle; Play Sound to Locate immediately restored Ready. The following observations summarize supplied debug logs. Raw logs, addresses, device identifiers, fabrics, certificates, and pairing material are intentionally not included.

- Xiaomi reads and Homebridge endpoint updates continued approximately every 15 seconds. The reported robot state was stopped, with no active error, Vacuum mode, and 90% battery.
- The robot's own subscription was successfully restored after the bridge restart. Its reports and later empty keepalives were acknowledged. Empty reports are normal when no subscribed attributes have changed.
- Locate invoked the native Identify command successfully. The single-attribute reports following it carried endpoint 1, Identify cluster `0x0003`, attribute `0x0000` (IdentifyTime), first 5 and then 0 seconds. They did not report a different RVC activity or cleaning mode.
- An earlier post-startup report contained a contradictory operational error structure: `errorStateId: 0`, with the old `errorStateDetails` text “Communication unavailable. Check the robot LAN connection.” still present.

## Confirmed defect and correction

The plugin cleared an error by submitting only `{ errorStateId: 0 }`. Homebridge applies updates through Matter.js, which merges the nested structure and can retain omitted fields. The plugin's own update log therefore looked healthy while the actual endpoint and encoded report still contained the old error description.

Recovery now explicitly sends `{ errorStateId: 0, errorStateDetails: "" }`. An empty details string is allowed by the Matter schema. The optional manufacturer-specific error label is not added to the standard NoError state. Regression tests exercise the actual Homebridge endpoint and the encoded error attribute across startup recovery, Xiaomi fault recovery, and communication recovery.

## Remaining uncertainty

The stale description is a confirmed bug, but the capture does not prove that it alone causes Apple Home's Updating tile. Identify recovered the UI without a new RVC state report. Testing the corrected package on the affected iPhone is still required.

A similar controller-side symptom is described in [Homebridge issue #3951](https://github.com/homebridge/homebridge/issues/3951) and [Home Assistant Matter Hub's iPhone troubleshooting](https://riddix.github.io/home-assistant-matter-hub/devices/robot-vacuum#iphone-shows-updating-but-ipad-works-fine). The latter project owns its Matter servers and offers session rotation. Homebridge 2.4's public plugin API does not expose session rotation or forced reports of unchanged attributes, so that workaround cannot be safely transferred as an ordinary plugin setting.

If Updating persists after this correction, compare a second Apple controller and correlate debug snapshots with subscription messages. A `Matter snapshot` with `error=0, errorDetails=empty` confirms that this specific stale-description defect is absent at the sampled endpoint; it does not confirm delivery or rendering on an iPhone.
