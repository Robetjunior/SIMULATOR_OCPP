const test = require("node:test");
const assert = require("node:assert/strict");
const { deterministicReplay, getScenarioDefinition } = require("../build/simulator");

test("replay deterministico reproduz timeline igual com a mesma seed", () => {
  const scenario = getScenarioDefinition("normal");
  const run1 = deterministicReplay(scenario, 777, 12);
  const run2 = deterministicReplay(scenario, 777, 12);

  assert.deepEqual(run1.timeline, run2.timeline);
  assert.deepEqual(run1.finalSample, run2.finalSample);
});
