import { SeededRandom } from "../core/random";
import type { ChargerStatus, TelemetryConfig, TelemetrySnapshot } from "../core/types";

const defaultConfig: TelemetryConfig = {
  maxPowerKW: 7,
  nominalVoltage: 230,
  maxCurrentA: 32,
  rampUpSeconds: 20,
  taperStartSoc: 70,
  targetSoc: 80,
  batteryCapacityKWh: 40,
  tempBase: 28,
  tempRate: 0.02,
  pricePerKWh: 1.99,
  seed: 12345,
};

export class TelemetryEngine {
  private config: TelemetryConfig;
  private random: SeededRandom;
  private elapsedSec = 0;
  private powerKW = 0;
  private voltageV = 230;
  private currentA = 0;
  private energyWhTotal = 0;
  private temperatureC = 28;
  private socPercent = 20;
  private paused = false;

  constructor(config?: Partial<TelemetryConfig>) {
    this.config = { ...defaultConfig, ...config };
    this.random = new SeededRandom(this.config.seed);
    this.reset();
  }

  reset(): void {
    this.elapsedSec = 0;
    this.powerKW = 0;
    this.voltageV = this.config.nominalVoltage;
    this.currentA = 0;
    this.energyWhTotal = 0;
    this.temperatureC = this.config.tempBase;
    this.socPercent = 20;
    this.paused = false;
    this.random = new SeededRandom(this.config.seed);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.powerKW = 0;
      this.currentA = 0;
    }
  }

  tick(status: ChargerStatus, dtSec = 1): TelemetrySnapshot {
    this.elapsedSec += dtSec;
    if (this.paused || status === "SuspendedEV" || status === "SuspendedEVSE" || status === "Faulted" || status === "Finishing") {
      this.voltageV = Math.max(210, this.config.nominalVoltage + this.random.centered(2));
      this.powerKW = 0;
      this.currentA = 0;
      this.temperatureC = Math.max(this.config.tempBase, this.temperatureC - 0.01 * dtSec);
      return this.snapshot(status);
    }

    const rampFactor = Math.min(1, this.elapsedSec / Math.max(1, this.config.rampUpSeconds));
    let taperFactor = 1;
    if (this.socPercent >= this.config.taperStartSoc) {
      const range = Math.max(1, 100 - this.config.taperStartSoc);
      const x = (this.socPercent - this.config.taperStartSoc) / range;
      taperFactor = Math.max(0.1, 1 - x * 0.9);
    }

    const targetPowerKW = Math.max(0, this.config.maxPowerKW * rampFactor * taperFactor + this.random.centered(0.05));
    this.voltageV = Math.max(210, this.config.nominalVoltage + this.random.centered(3));
    this.currentA = Math.min(this.config.maxCurrentA, (targetPowerKW * 1000) / Math.max(1, this.voltageV));
    this.powerKW = (this.voltageV * this.currentA) / 1000;

    const deltaWh = (this.powerKW * 1000 * dtSec) / 3600;
    this.energyWhTotal += Math.max(0, deltaWh);
    this.temperatureC = Math.max(this.config.tempBase, this.temperatureC + this.config.tempRate * dtSec + this.random.centered(0.02));
    const deltaSoc = ((deltaWh / 1000) / this.config.batteryCapacityKWh) * 100;
    this.socPercent = Math.min(this.config.targetSoc, Math.min(100, this.socPercent + Math.max(0, deltaSoc)));

    return this.snapshot(status);
  }

  snapshot(status: ChargerStatus): TelemetrySnapshot {
    const energyKWhTotal = this.energyWhTotal / 1000;
    return {
      timestamp: new Date().toISOString(),
      elapsedSec: this.elapsedSec,
      status,
      powerKW: this.powerKW,
      voltageV: this.voltageV,
      currentA: this.currentA,
      energyWhTotal: this.energyWhTotal,
      energyKWhTotal,
      temperatureC: this.temperatureC,
      socPercent: this.socPercent,
      pricePerKWh: this.config.pricePerKWh,
      totalCost: energyKWhTotal * this.config.pricePerKWh,
      paused: this.paused,
    };
  }
}
