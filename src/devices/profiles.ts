/** Profiles contain protocol facts, independently of HomeKit presentation. */
export const SUPPORTED_MODELS: readonly string[] = ['zhimi.airp.cpa4', 'xiaomi.airp.cpa4'];

export function isSupportedModel(model: string): boolean {
  return SUPPORTED_MODELS.includes(model);
}

export interface MiotProperty {
  readonly siid: number;
  readonly piid: number;
  readonly format: 'boolean' | 'integer';
  readonly min?: number;
  readonly max?: number;
  readonly writable?: boolean;
}

export interface PurifierState {
  readonly power: boolean;
  readonly fault: number;
  readonly mode: number;
  readonly pm25: number;
  readonly filterLife: number;
  readonly childLock: boolean;
  readonly favoriteLevel: number;
  readonly motorRpm: number;
  /** Actual screen enum: 0 off, 1 dim, 2 bright; absent when display controls are disabled. */
  readonly displayBrightness?: number;
  readonly sampledAt: number;
}

export type PurifierProperty = Exclude<keyof PurifierState, 'sampledAt'>;
export type WritablePurifierProperty = 'power' | 'mode' | 'childLock' | 'favoriteLevel' | 'displayBrightness';

export interface PurifierProfile {
  readonly productName: string;
  readonly source: string;
  readonly properties: Readonly<Record<PurifierProperty, MiotProperty>>;
  readonly favoriteLevels: number;
  readonly maximumRpm: number;
  readonly faults: Readonly<Record<number, string>>;
}

// Verified against the Xiaomi MIoT instance API, 2026-09-17. Both variants use
// these property IDs; their filter reset action signatures differ (not exposed).
const CPA4_PROPERTIES = {
  power: { siid: 2, piid: 1, format: 'boolean', writable: true },
  fault: { siid: 2, piid: 2, format: 'integer', min: 0, max: 255 },
  mode: { siid: 2, piid: 4, format: 'integer', min: 0, max: 2, writable: true },
  pm25: { siid: 3, piid: 4, format: 'integer', min: 0, max: 600 },
  filterLife: { siid: 4, piid: 1, format: 'integer', min: 0, max: 100 },
  childLock: { siid: 8, piid: 1, format: 'boolean', writable: true },
  favoriteLevel: { siid: 9, piid: 11, format: 'integer', min: 0, max: 14, writable: true },
  motorRpm: { siid: 9, piid: 1, format: 'integer', min: 0, max: 2500 },
  displayBrightness: { siid: 13, piid: 2, format: 'integer', min: 0, max: 2, writable: true },
} as const satisfies Record<PurifierProperty, MiotProperty>;

export function getPurifierProfile(model: string): PurifierProfile {
  if (!isSupportedModel(model)) {
    throw new Error(`Unsupported purifier model: ${model}`);
  }
  const instance = model === 'zhimi.airp.cpa4' ? 'zhimi-cpa4:1' : 'xiaomi-cpa4:2';
  return {
    productName: 'Xiaomi Smart Air Purifier 4 Compact',
    source: `https://miot-spec.org/miot-spec-v2/instance?type=urn:miot-spec-v2:device:air-purifier:0000A007:${instance}`,
    properties: CPA4_PROPERTIES,
    favoriteLevels: 15,
    maximumRpm: 2500,
    faults: { 0: 'No faults', 2: 'Motor stuck', 3: 'Particulate sensor unavailable' },
  };
}

/** A display policy for the required HomeKit category, not a calibrated AQI. */
export function airQualityFromPm25(pm25: number): number {
  if (!Number.isFinite(pm25) || pm25 < 0) {
    return 0;
  }
  if (pm25 <= 12) { return 1; }
  if (pm25 <= 35) { return 2; }
  if (pm25 <= 55) { return 3; }
  if (pm25 <= 150) { return 4; }
  return 5;
}

export function favoriteLevelFromPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent < 2 || percent > 100) {
    throw new Error('Manual speed must be between 2 and 100 percent.');
  }
  return Math.round((percent - 2) * 14 / 98);
}

export function percentFromFavoriteLevel(level: number): number {
  return Math.round(2 + Math.max(0, Math.min(14, level)) * 98 / 14);
}
