const test = require("node:test");
const assert = require("node:assert/strict");

test("suite E2E base contra CSMS fica disponivel via env", { skip: !process.env.CSMS_BASE_URL }, async () => {
  const baseUrl = process.env.CSMS_BASE_URL;
  const response = await fetch(`${baseUrl}/health`).catch(() => null);
  assert.ok(response, "CSMS deve responder ao endpoint /health para habilitar os testes E2E");
});
