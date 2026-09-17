import { setImmediate as nextTurn } from 'node:timers/promises';
import type { API, Logger, MatterAccessory, MatterAPI } from 'homebridge';
import { deviceIdentity, type DeviceConfig } from '../config.js';
import { VacuumCommandError, VacuumDevice, VacuumStateError } from '../devices/vacuum.js';
import { cleaningModeForState, findCleaningMode, VACUUM_CLEAN_MODES } from './vacuum-modes.js';
import { getVacuumProfile, hasVacuumFault, type VacuumState } from '../devices/vacuum-profile.js';
import type { MiotTransport } from '../miio/transport.js';

// Homebridge 2.4 exposes RvcOperationalState enums, but not these other
// standard clusters' enums. Values are defined by the Matter specification.
const RUN_TAG = { Idle: 0x4000, Cleaning: 0x4001 } as const;
const CLEAN_TAG = { Vacuum: 0x4001, Mop: 0x4002 } as const;
const POWER = {
  Status: { Unspecified: 0, Active: 1, Standby: 2 },
  Level: { Ok: 0, Warning: 1, Critical: 2 },
  Charging: { Unknown: 0, IsCharging: 1, IsNotCharging: 3 },
} as const;

/** A real Matter robotic vacuum. HAP has no robotic vacuum service. */
export class VacuumAccessory {
  readonly accessory: MatterAccessory;
  private readonly matter: MatterAPI;
  private readonly device: VacuumDevice;
  private readonly pollMilliseconds: number;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshCount = 0;
  private running = false;
  private closed = false;
  private lastProblem?: string;
  private lastFault?: number;
  private preferredCleanMode?: number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly exhausted = new Set<string>();

  constructor(
    api: API,
    private readonly log: Logger,
    UUID: string,
    private readonly config: DeviceConfig,
    transport: MiotTransport,
    pollInterval: number,
  ) {
    if (!api.matter) throw new Error('Matter must be enabled to add a robot vacuum.');
    this.matter = api.matter;
    this.device = new VacuumDevice(transport, getVacuumProfile(config.model), config.did);
    this.pollMilliseconds = Math.max(10, Number.isFinite(pollInterval) ? pollInterval : 15) * 1000;
    const { RvcOperationalState: Op } = this.matter.types;
    this.accessory = {
      UUID,
      displayName: config.name,
      deviceType: this.matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber: config.did ?? config.id ?? UUID,
      manufacturer: 'Xiaomi',
      model: config.model,
      context: { identity: deviceIdentity(config), model: config.model },
      clusters: {
        identify: { identifyTime: 0, identifyType: 3 /* AudibleBeep */ },
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: 0, modeTags: [{ value: RUN_TAG.Idle }] },
            { label: 'Cleaning', mode: 1, modeTags: [{ value: RUN_TAG.Cleaning }] },
          ],
          currentMode: 0,
        },
        rvcCleanMode: {
          supportedModes: VACUUM_CLEAN_MODES.map(mode => ({
            mode: mode.mode, label: mode.label,
            modeTags: mode.settings.mode === 1 ? [{ value: CLEAN_TAG.Vacuum }, { value: CLEAN_TAG.Mop }]
              : [{ value: mode.settings.mode === 2 ? CLEAN_TAG.Mop : CLEAN_TAG.Vacuum }],
          })),
          currentMode: 0,
        },
        rvcOperationalState: {
          operationalStateList: [
            Op.OperationalState.Stopped, Op.OperationalState.Running, Op.OperationalState.Paused,
            Op.OperationalState.Error, Op.OperationalState.SeekingCharger, Op.OperationalState.Charging,
          ].map(operationalStateId => ({ operationalStateId })),
          ...this.unavailableState(),
        },
        powerSource: {
          status: POWER.Status.Unspecified,
          order: 0,
          description: 'Rechargeable battery',
          batPercentRemaining: null,
          batChargeLevel: POWER.Level.Ok,
          batReplaceability: 0 /* Unspecified */,
          batReplacementNeeded: false,
          batPresent: true,
          batChargeState: POWER.Charging.Unknown,
          batFunctionalWhileCharging: false,
        },
      },
      handlers: {
        identify: {
          identify: async request => {
            // IdentifyTime 0 cancels identification; do not make another sound.
            if (request && request.identifyTime > 0) await this.command(() => this.device.identify());
          },
        },
        rvcRunMode: {
          changeToMode: async request => {
            if (!request || ![0, 1].includes(request.newMode)) {
              throw new this.matter.status.ConstraintError('Unsupported vacuum run mode.');
            }
            // E10's stop-sweeping action pauses in place. Idle must end cleaning,
            // so Stop/Idle returns to the dock; the native Pause command is separate.
            await this.command(async () => {
              // Use a fresh reading within the serialized command. Reasserting
              // Cleaning must not resume a robot paused with its physical button.
              const state = await this.device.refresh();
              if (this.runMode(state) === request.newMode) return state;
              return request.newMode === 1 ? this.device.start() : this.device.dock();
            }, undefined, request.newMode);
          },
        },
        rvcCleanMode: {
          changeToMode: async request => {
            const selected = request && findCleaningMode(request.newMode);
            if (!selected) throw new this.matter.status.ConstraintError('Unsupported vacuum cleaning mode.');
            // The device transaction rechecks idle state before writing the
            // preset, preserving suction/water settings not named by the preset.
            await this.command(() => this.device.configureCleaning(selected.settings), selected.mode);
          },
        },
        rvcOperationalState: {
          pause: async () => { await this.command(() => this.device.pause()); },
          resume: async () => { await this.command(() => this.device.resume()); },
          goHome: async () => { await this.command(() => this.device.dock()); },
        },
      },
    };
  }

  /** Call only after Homebridge has finished registering the external accessory. */
  start(): void {
    if (this.running || this.closed) return;
    this.running = true;
    this.log.debug(`${this.config.name}: background polling started (${this.pollMilliseconds / 1000}s interval).`);
    // Homebridge restores persisted attributes while registering the endpoint.
    // Clear stale health/battery before the first fresh device response arrives.
    void this.enqueue(() => this.markUnavailable()).catch(error => this.reportUpdateError(error)).then(() => this.pollCycle());
  }

  stop(): void {
    if (this.closed) return;
    this.running = false;
    this.closed = true;
    clearTimeout(this.timer);
    this.device.close();
  }

  refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      try {
        const state = await this.device.refresh();
        if (!this.closed) {
          await this.publish(state);
          this.refreshCount++;
          this.log.debug(`${this.config.name}: state read #${this.refreshCount}: status=${state.status} (${this.device.profile.statuses[state.status]}), mode=${state.mode}, battery=${state.battery}%, fault=${state.fault}; Matter update submitted.`);
        }
      } catch (error) {
        if (!this.closed) await this.reportUnavailable(error);
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.queue.then(operation);
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async pollCycle(): Promise<void> {
    try {
      await this.refresh();
      await this.logMatterSnapshot();
    } catch (error) {
      this.reportUpdateError(error);
    } finally {
      if (this.running && !this.closed) {
        this.timer = setTimeout(() => { void this.pollCycle(); }, this.pollMilliseconds);
        this.timer.unref();
      }
    }
  }

  private async logMatterSnapshot(): Promise<void> {
    // Homebridge's update API resolves after emitting an event, before endpoint
    // updates finish. Yield before sampling the public, live endpoint state.
    // This is a diagnostic snapshot, not proof of delivery to an Apple client.
    await nextTurn();
    if (this.closed) return;
    try {
      const [operation, run, power] = await Promise.all([
        this.matter.getAccessoryState(this.accessory.UUID, 'rvcOperationalState'),
        this.matter.getAccessoryState(this.accessory.UUID, 'rvcRunMode'),
        this.matter.getAccessoryState(this.accessory.UUID, 'powerSource'),
      ]);
      if (this.closed) return;
      const number = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) ? String(value) : 'unknown';
      this.log.debug(`${this.config.name}: Matter snapshot: activity=${number(operation?.operationalState)}, runMode=${number(run?.currentMode)}, batteryHalfPercent=${number(power?.batPercentRemaining)}, error=${number(operation?.operationalError?.errorStateId)}, errorDetails=${typeof operation?.operationalError?.errorStateDetails === 'string' && operation.operationalError.errorStateDetails.length > 0 ? 'present' : 'empty'}.`);
    } catch (error) {
      if (!this.closed) this.log.debug(`${this.config.name}: Matter snapshot unavailable (${this.safeMessage(error)}).`);
    }
  }

  private command(action: () => Promise<VacuumState>, cleanMode?: number, runMode?: number): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) throw new this.matter.status.Failure('Device connection is closed.');
      try {
        const state = await action();
        // The device layer confirms asynchronous changes without replaying writes.
        if (this.closed) throw new this.matter.status.Failure('Device connection is closed.');
        if (cleanMode !== undefined) this.preferredCleanMode = cleanMode;
        await this.publish(state);
        if (runMode !== undefined && this.runMode(state) !== runMode) {
          throw new this.matter.status.Failure('The robot has not confirmed the requested run mode.');
        }
        if (cleanMode !== undefined && cleaningModeForState(state, cleanMode) !== cleanMode) {
          throw new this.matter.status.Failure('The robot has not confirmed all settings of the cleaning preset.');
        }
      } catch (error) {
        if (error instanceof VacuumCommandError) {
          if (!this.closed) {
            await this.publish(error.state);
            this.log.warn(`${this.config.name}: command not completed (${this.safeMessage(error)}). Device is still reachable.`);
          }
          throw new this.matter.status.Failure(this.safeMessage(error));
        }
        if (error instanceof VacuumStateError) {
          await this.publish(error.state);
          throw new this.matter.status.InvalidInState(error.message);
        }
        if (this.matter.status.isMatterProtocolError(error)) throw error;
        if (!this.closed) await this.reportUnavailable(error);
        throw new this.matter.status.Failure('The robot did not confirm the requested operation.');
      }
    });
  }

  private runMode(state: VacuumState): number {
    return [2, 5, 6, 7].includes(state.status) ? 1 : 0;
  }

  private unavailableState(): Record<string, unknown> {
    const Op = this.matter.types.RvcOperationalState;
    return {
      operationalState: Op.OperationalState.Error,
      operationalError: {
        errorStateId: Op.ErrorState.UnableToCompleteOperation,
        errorStateDetails: 'Communication unavailable. Check the robot LAN connection.',
      },
    };
  }

  private async markUnavailable(): Promise<void> {
    await this.update('rvcOperationalState', this.unavailableState());
    await this.update('powerSource', {
      status: POWER.Status.Unspecified,
      batPercentRemaining: null,
      batChargeState: POWER.Charging.Unknown,
    });
  }

  private async publish(state: VacuumState): Promise<void> {
    const { RvcOperationalState: Op } = this.matter.types;
    const running = [5, 6, 7].includes(state.status);
    let operationalState = Op.OperationalState.Stopped;
    if (running) operationalState = Op.OperationalState.Running;
    else if (state.status === 2) operationalState = Op.OperationalState.Paused;
    else if (state.status === 3) operationalState = Op.OperationalState.SeekingCharger;
    else if (state.status === 4) operationalState = Op.OperationalState.Charging;
    // Matter.js merges nested structs: omitting details retains the previous
    // fault text even with NoError. Explicitly clear it on every healthy reading.
    let operationalError: Record<string, unknown> = {
      errorStateId: Op.ErrorState.NoError,
      errorStateDetails: '',
    };
    const faulted = hasVacuumFault(this.device.profile, state.fault);
    if (faulted) {
      operationalState = Op.OperationalState.Error;
      operationalError = {
        errorStateId: Op.ErrorState.UnableToCompleteOperation,
        errorStateDetails: `Xiaomi error ${state.fault}. See Xiaomi Home for recovery instructions.`,
      };
    } else if (state.status === 8) {
      operationalState = Op.OperationalState.Error;
      operationalError = {
        errorStateId: Op.ErrorState.CommandInvalidInState,
        errorStateDetails: 'Firmware update in progress. Wait for the robot to finish.',
      };
    }
    await this.update('rvcRunMode', { currentMode: this.runMode(state) });
    const rememberedMode = this.preferredCleanMode ?? Number(this.accessory.clusters!.rvcCleanMode!.currentMode);
    const currentMode = cleaningModeForState(state, rememberedMode);
    this.preferredCleanMode = currentMode;
    await this.update('rvcCleanMode', { currentMode });
    await this.update('rvcOperationalState', { operationalState, operationalError });
    await this.update('powerSource', {
      status: state.status === 4 ? POWER.Status.Standby : POWER.Status.Active,
      batPercentRemaining: state.battery * 2,
      batChargeLevel: state.battery <= 5 ? POWER.Level.Critical
        : state.battery <= 20 ? POWER.Level.Warning : POWER.Level.Ok,
      batChargeState: state.status === 4 ? POWER.Charging.IsCharging : POWER.Charging.IsNotCharging,
    });
    if (this.lastProblem !== undefined) {
      this.log.info(`${this.config.name}: device communication restored.`);
      this.lastProblem = undefined;
    }
    if (state.fault !== this.lastFault) {
      if (faulted) {
        this.log.warn(`${this.config.name}: Xiaomi device error ${state.fault} (status ${state.status}, battery ${state.battery}%). Check Xiaomi Home for details.`);
      } else if (this.lastFault !== undefined && hasVacuumFault(this.device.profile, this.lastFault)) {
        this.log.info(`${this.config.name}: device fault cleared.`);
      }
      this.lastFault = state.fault;
    }
    for (const [key, label] of [
      ['filterLife', 'filter'], ['mainBrushLife', 'main brush'], ['sideBrushLife', 'side brush'], ['mopLife', 'mop pad'],
    ] as const) {
      if (state[key] === 0 && !this.exhausted.has(key)) {
        this.log.warn(`${this.config.name}: ${label} life is 0%; check and replace it in Xiaomi Home.`);
        this.exhausted.add(key);
      } else if (state[key] > 0) this.exhausted.delete(key);
    }
  }

  private async update(cluster: string, attributes: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    await this.matter.updateAccessoryState(this.accessory.UUID, cluster, attributes);
    // Keep the declarative state consistent for Homebridge's cache and callers.
    const clusters = this.accessory.clusters!;
    clusters[cluster] = { ...clusters[cluster], ...attributes };
  }

  private async reportUnavailable(error: unknown): Promise<void> {
    try { await this.markUnavailable(); } catch (updateError) { this.reportUpdateError(updateError); }
    const message = this.safeMessage(error);
    if (message !== this.lastProblem) {
      this.log.warn(`${this.config.name}: unavailable (${message}). Check power, LAN address and token.`);
      this.lastProblem = message;
    }
  }

  private reportUpdateError(error: unknown): void {
    if (!this.closed) this.log.warn(`${this.config.name}: cannot update Matter state (${this.safeMessage(error)}).`);
  }

  private safeMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Device communication failed';
    return message.split(this.config.token).join('[redacted]').replace(/[\r\n]/g, ' ').slice(0, 200);
  }
}
