import type { VacuumState } from '../devices/vacuum-profile.js';

interface CleaningSettings { readonly mode: number; readonly suction?: number; readonly water?: number }
export interface VacuumCleaningMode {
  readonly mode: number;
  readonly label: string;
  readonly settings: CleaningSettings;
}

// Keep mode IDs stable across releases: Matter persists the selected ID.
// The E10 specification names levels numerically, not Quiet/Turbo/etc.
export const VACUUM_CLEAN_MODES: readonly VacuumCleaningMode[] = [
  { mode: 0, label: 'Vacuum', settings: { mode: 0 } },
  { mode: 1, label: 'Vacuum and mop', settings: { mode: 1 } },
  { mode: 2, label: 'Mop', settings: { mode: 2 } },
  ...[1, 2, 3, 4].map(level => ({ mode: 9 + level, label: `Vacuum: suction ${level}`, settings: { mode: 0, suction: level } })),
  ...[1, 2, 3, 4].map(level => ({ mode: 19 + level, label: `Vacuum and mop: suction ${level}`, settings: { mode: 1, suction: level } })),
  ...[1, 2, 3].map(level => ({ mode: 29 + level, label: `Mop: water ${level}`, settings: { mode: 2, water: level } })),
  ...[1, 2, 3].map(level => ({ mode: 39 + level, label: `Vacuum and mop: water ${level}`, settings: { mode: 1, water: level } })),
];

export function findCleaningMode(mode: number): VacuumCleaningMode | undefined {
  return VACUUM_CLEAN_MODES.find(candidate => candidate.mode === mode);
}

/** Preserve a selected preset only while every setting it claims is true. */
export function cleaningModeForState(state: VacuumState, previous?: number): number {
  const settings = previous === undefined ? undefined : findCleaningMode(previous)?.settings;
  if (settings && settings.mode === state.mode
    && (settings.suction === undefined || settings.suction === state.suction)
    && (settings.water === undefined || settings.water === state.water)) return previous!;
  return state.mode;
}
