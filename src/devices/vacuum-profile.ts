import type { MiotProperty } from './profiles.js';

export const SUPPORTED_VACUUM_MODELS: readonly string[] = ['xiaomi.vacuum.b112'];

export interface VacuumState {
  readonly status: number;
  readonly fault: number;
  /** 0: vacuum, 1: vacuum and mop, 2: mop. */
  readonly mode: number;
  readonly battery: number;
  readonly suction: number;
  readonly water: number;
  readonly filterLife: number;
  readonly mainBrushLife: number;
  readonly sideBrushLife: number;
  readonly mopLife: number;
  readonly sampledAt: number;
}

export type VacuumProperty = Exclude<keyof VacuumState, 'sampledAt'>;
export type WritableVacuumProperty = 'mode' | 'suction' | 'water';
export interface MiotAction { readonly siid: number; readonly aiid: number }
export interface VacuumProfile {
  readonly productName: string;
  readonly source: string;
  readonly properties: Readonly<Record<VacuumProperty, MiotProperty>>;
  readonly actions: Readonly<Record<'start' | 'stop' | 'dock', MiotAction>>;
  readonly identify: MiotProperty;
  readonly statuses: Readonly<Record<number, string>>;
}

// Verified against Xiaomi's MIoT instance API on 2026-09-17. Do not extend this
// profile to E10C/E12 variants merely because their product names are similar.
const E10_PROFILE: VacuumProfile = {
  productName: 'Xiaomi Robot Vacuum E10',
  source: 'https://miot-spec.org/miot-spec-v2/instance?type=urn:miot-spec-v2:device:vacuum:0000A006:xiaomi-b112:1',
  properties: {
    status: { siid: 2, piid: 1, format: 'integer', min: 0, max: 8 },
    // The specification supplies a range, not an error-code dictionary.
    fault: { siid: 2, piid: 2, format: 'integer', min: 0, max: 3000 },
    mode: { siid: 2, piid: 4, format: 'integer', min: 0, max: 2, writable: true },
    battery: { siid: 3, piid: 1, format: 'integer', min: 0, max: 100 },
    suction: { siid: 7, piid: 5, format: 'integer', min: 0, max: 4, writable: true },
    water: { siid: 7, piid: 6, format: 'integer', min: 0, max: 3, writable: true },
    filterLife: { siid: 7, piid: 12, format: 'integer', min: 0, max: 100 },
    mainBrushLife: { siid: 7, piid: 10, format: 'integer', min: 0, max: 100 },
    sideBrushLife: { siid: 7, piid: 8, format: 'integer', min: 0, max: 100 },
    mopLife: { siid: 7, piid: 14, format: 'integer', min: 0, max: 100 },
  },
  actions: {
    start: { siid: 2, aiid: 1 },
    stop: { siid: 2, aiid: 2 },
    dock: { siid: 3, aiid: 1 },
  },
  identify: { siid: 4, piid: 1, format: 'integer', min: 1, max: 1, writable: true },
  statuses: {
    0: 'Sleeping', 1: 'Idle', 2: 'Paused', 3: 'Returning to dock',
    4: 'Charging', 5: 'Vacuuming', 6: 'Vacuuming and mopping', 7: 'Mopping', 8: 'Updating firmware',
  },
};

export function getVacuumProfile(model: string): VacuumProfile {
  if (!SUPPORTED_VACUUM_MODELS.includes(model)) {
    throw new Error(`Unsupported vacuum model: ${model}`);
  }
  return E10_PROFILE;
}
