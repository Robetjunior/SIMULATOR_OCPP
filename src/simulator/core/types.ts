export type ChargerStatus =
  | "Available"
  | "Preparing"
  | "Charging"
  | "SuspendedEV"
  | "SuspendedEVSE"
  | "Finishing"
  | "Unavailable"
  | "Faulted";

export type StopReason =
  | "Local"
  | "Remote"
  | "PowerLoss"
  | "EVDisconnected"
  | "UserDefinedLimit"
  | "Other";

export interface SessionScenario {
  name: string;
  includeSoc: boolean;
  includeTemperature: boolean;
  pauseReason?: "SuspendedEV" | "SuspendedEVSE";
  pauseAtSec?: number;
  pauseDurationSec?: number;
  injectFaultAtSec?: number;
  faultCode?: string;
  stopReason?: StopReason;
  meterIntervalSec: number;
  heartbeatIntervalSec: number;
  postpaid?: boolean;
}

export interface TelemetryConfig {
  maxPowerKW: number;
  nominalVoltage: number;
  maxCurrentA: number;
  rampUpSeconds: number;
  taperStartSoc: number;
  targetSoc: number;
  batteryCapacityKWh: number;
  tempBase: number;
  tempRate: number;
  pricePerKWh: number;
  seed?: number;
}

export interface TelemetrySnapshot {
  timestamp: string;
  elapsedSec: number;
  status: ChargerStatus;
  powerKW: number;
  voltageV: number;
  currentA: number;
  energyWhTotal: number;
  energyKWhTotal: number;
  temperatureC?: number;
  socPercent?: number;
  pricePerKWh: number;
  totalCost: number;
  paused: boolean;
}

export interface TimelineEvent {
  type: string;
  at: string;
  status: ChargerStatus;
  payload: Record<string, unknown>;
}
