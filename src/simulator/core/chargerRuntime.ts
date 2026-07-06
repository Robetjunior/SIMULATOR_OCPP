import { ChargerStateMachine } from "./chargerStateMachine";
import { TimelineRecorder } from "./timeline";
import type { SessionScenario, TelemetrySnapshot } from "./types";
import { TelemetryEngine } from "../telemetry/telemetryEngine";
import { buildMeterValuesPayload } from "../ocpp/payloadBuilders";

export interface RuntimeOptions {
  scenario: SessionScenario;
  connectorId?: number;
  chargeBoxId?: string;
  idTag?: string;
  seed?: number;
}

export class ChargerRuntime {
  readonly machine = new ChargerStateMachine();
  readonly timeline = new TimelineRecorder();
  readonly telemetry: TelemetryEngine;
  readonly scenario: SessionScenario;
  readonly connectorId: number;
  readonly chargeBoxId: string;
  readonly idTag: string;
  heartbeatIntervalSec: number;
  transactionId = 1;

  constructor(options: RuntimeOptions) {
    this.scenario = options.scenario;
    this.connectorId = options.connectorId ?? 1;
    this.chargeBoxId = options.chargeBoxId ?? "DRBAKANA-TEST-03";
    this.idTag = options.idTag ?? "IGEA-USER-001";
    this.heartbeatIntervalSec = options.scenario.heartbeatIntervalSec;
    this.telemetry = new TelemetryEngine({ seed: options.seed });
    this.timeline.record("runtime_created", this.machine.state, {
      scenario: this.scenario.name,
      chargeBoxId: this.chargeBoxId,
    });
  }

  onBootResponse(status: "Accepted" | "Pending" | "Rejected", intervalSec?: number): void {
    this.timeline.record("boot_response", this.machine.state, { status, intervalSec });
    if (status === "Accepted") {
      this.heartbeatIntervalSec = intervalSec ?? this.heartbeatIntervalSec;
      this.machine.transition("Available");
    }
    if (status === "Rejected") {
      this.machine.transition("Unavailable");
    }
  }

  startSession(): void {
    this.machine.transition("Preparing");
    this.timeline.record("status", this.machine.state, { next: this.machine.state });
    this.machine.transition("Charging");
    this.timeline.record("status", this.machine.state, { next: this.machine.state });
  }

  tick(dtSec = 1): TelemetrySnapshot {
    const elapsed = this.telemetry.snapshot(this.machine.state).elapsedSec;

    if (this.scenario.injectFaultAtSec && elapsed >= this.scenario.injectFaultAtSec && this.machine.state !== "Faulted") {
      this.telemetry.setPaused(true);
      this.machine.transition("Faulted");
      this.timeline.record("fault", this.machine.state, { errorCode: this.scenario.faultCode || "OtherError" });
    }

    if (
      this.scenario.pauseReason &&
      this.scenario.pauseAtSec != null &&
      this.machine.state === "Charging" &&
      elapsed >= this.scenario.pauseAtSec &&
      elapsed < this.scenario.pauseAtSec + (this.scenario.pauseDurationSec || 0)
    ) {
      this.telemetry.setPaused(true);
      this.machine.transition(this.scenario.pauseReason);
      this.timeline.record("status", this.machine.state, { next: this.machine.state });
    } else if (
      this.scenario.pauseReason &&
      this.scenario.pauseAtSec != null &&
      (this.machine.state === "SuspendedEV" || this.machine.state === "SuspendedEVSE") &&
      elapsed >= this.scenario.pauseAtSec + (this.scenario.pauseDurationSec || 0)
    ) {
      this.telemetry.setPaused(false);
      this.machine.transition("Charging");
      this.timeline.record("status", this.machine.state, { next: this.machine.state });
    }

    const sample = this.telemetry.tick(this.machine.state, dtSec);
    this.timeline.record("tick", this.machine.state, {
      powerKW: sample.powerKW,
      energyWhTotal: sample.energyWhTotal,
    });
    return sample;
  }

  buildPeriodicMeterValues(sample: TelemetrySnapshot) {
    return buildMeterValuesPayload(this.connectorId, this.transactionId, sample, this.scenario, "Sample.Periodic");
  }

  stopSession(): TelemetrySnapshot {
    this.telemetry.setPaused(true);
    this.machine.transition("Finishing");
    this.timeline.record("status", this.machine.state, { next: this.machine.state });
    const finalSample = this.telemetry.tick(this.machine.state, 0);
    this.machine.transition("Available");
    this.timeline.record("status", this.machine.state, { next: this.machine.state });
    return finalSample;
  }
}
