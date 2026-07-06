const test = require("node:test");
const assert = require("node:assert/strict");
const { ChargerStateMachine } = require("../build/simulator");

test("state machine aceita transicoes validas", () => {
  const machine = new ChargerStateMachine();
  assert.equal(machine.transition("Preparing"), true);
  assert.equal(machine.transition("Charging"), true);
  assert.equal(machine.transition("SuspendedEV"), true);
  assert.equal(machine.transition("Charging"), true);
  assert.equal(machine.transition("Finishing"), true);
  assert.equal(machine.transition("Available"), true);
});

test("state machine rejeita transicao invalida", () => {
  const machine = new ChargerStateMachine();
  assert.equal(machine.transition("Charging"), false);
  assert.equal(machine.state, "Available");
});
