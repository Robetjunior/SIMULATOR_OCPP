import type { SessionScenario, TelemetrySnapshot } from "../core/types";

export type SampleContext = "Transaction.Begin" | "Sample.Periodic" | "Transaction.End";

export function buildSampledValues(
  sample: TelemetrySnapshot,
  scenario: SessionScenario,
  context: SampleContext,
): Array<Record<string, string>> {
  const sampled: Array<Record<string, string>> = [];

  sampled.push({
    value: String(Math.round(sample.energyWhTotal)),
    context,
    format: "Raw",
    measurand: "Energy.Active.Import.Register",
    unit: "Wh",
    location: "Outlet",
  });
  sampled.push({
    value: sample.powerKW.toFixed(3),
    context,
    format: "Raw",
    measurand: "Power.Active.Import",
    unit: "kW",
    location: "Outlet",
  });
  sampled.push({
    value: String(Math.round(sample.voltageV)),
    context,
    format: "Raw",
    measurand: "Voltage",
    unit: "V",
    phase: "L1-N",
    location: "Outlet",
  });
  sampled.push({
    value: sample.currentA.toFixed(2),
    context,
    format: "Raw",
    measurand: "Current.Import",
    unit: "A",
    phase: "L1",
    location: "Outlet",
  });

  if (scenario.includeTemperature && sample.temperatureC != null) {
    sampled.push({
      value: sample.temperatureC.toFixed(2),
      context,
      format: "Raw",
      measurand: "Temperature",
      unit: "Celsius",
      location: "Body",
    });
  }

  if (scenario.includeSoc && sample.socPercent != null) {
    sampled.push({
      value: String(Math.round(sample.socPercent)),
      context,
      format: "Raw",
      measurand: "SoC",
      unit: "Percent",
    });
  }

  return sampled;
}

export function buildMeterValuesPayload(
  connectorId: number,
  transactionId: number,
  sample: TelemetrySnapshot,
  scenario: SessionScenario,
  context: SampleContext,
) {
  return {
    connectorId,
    transactionId,
    meterValue: [
      {
        timestamp: sample.timestamp,
        sampledValue: buildSampledValues(sample, scenario, context),
      },
    ],
  };
}
