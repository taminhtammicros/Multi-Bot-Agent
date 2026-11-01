import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseMain, type Agent } from "../src/agents.js";
import { parseDelegation } from "../src/engine.js";
const agent = (id: string, health = "online", enabled = true) =>
  ({ id, health, enabled }) as Agent;
test("only configured available agent becomes Main", () => {
  assert.equal(
    chooseMain([agent("openclaw"), agent("hermes", "unconfigured", false)]),
    "openclaw",
  );
  assert.equal(chooseMain([agent("hermes")]), "hermes");
});
test("Hermes preferred; OpenClaw takes over downtime", () => {
  assert.equal(chooseMain([agent("openclaw"), agent("hermes")]), "hermes");
  assert.equal(
    chooseMain([agent("openclaw"), agent("hermes", "offline")]),
    "openclaw",
  );
  assert.equal(chooseMain([agent("hermes", "offline")]), null);
});
test("hold backup until recovery window has elapsed", () => {
  const agents = [agent("hermes"), agent("openclaw")];
  assert.equal(
    chooseMain(agents, "auto", "openclaw", 60, new Date()),
    "openclaw",
  );
  assert.equal(
    chooseMain(agents, "auto", "openclaw", 60, new Date(Date.now() - 61000)),
    "hermes",
  );
});
test("explicit preference still falls back", () => {
  assert.equal(
    chooseMain([agent("hermes"), agent("openclaw")], "openclaw"),
    "openclaw",
  );
  assert.equal(
    chooseMain([agent("hermes"), agent("openclaw", "offline")], "openclaw"),
    "hermes",
  );
});
test("delegation accepts only bounded explicit task envelope", () => {
  assert.equal(
    parseDelegation('{"action":"delegate_openclaw","task":"Check files"}'),
    "Check files",
  );
  assert.equal(parseDelegation("normal answer"), null);
  assert.equal(
    parseDelegation('{"action":"delegate_openclaw","task":""}'),
    null,
  );
  assert.equal(parseDelegation('{"action":"other","task":"x"}'), null);
});
