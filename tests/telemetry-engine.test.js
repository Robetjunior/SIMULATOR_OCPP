const test = require("node:test");
const assert = require("node:assert/strict");
const { TelemetryEngine, buildSampledValues, getScenarioDefinition } = require("../build/simulator");

test("telemetria mantem energia crescente e coerente", () => {
  const engine = new TelemetryEngine({ seed: 12345 });
  let previousEnergy = 0;
  for (let i = 0; i < 10; i += 1) {
    const sample = engine.tick("Charging", 1);
    assert.ok(sample.energyWhTotal >= previousEnergy);
    assert.ok(sample.powerKW >= 0);
    previousEnergy = sample.energyWhTotal;
  }
});

test("sampled values omitem SoC quando cenario nao inclui SoC", () => {
  const engine = new TelemetryEngine({ seed: 12345 });
  const sample = engine.tick("Charging", 1);
  const scenario = getScenarioDefinition("missing_soc");
  const sampled = buildSampledValues(sample, scenario, "Sample.Periodic");
  assert.equal(sampled.some((item) => item.measurand === "SoC"), false);
  assert.equal(sampled.some((item) => item.measurand === "Temperature"), true);
});
