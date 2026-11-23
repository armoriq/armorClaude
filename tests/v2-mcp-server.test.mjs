import test from "node:test";
import assert from "node:assert/strict";
import * as ir from "@armoriq/policy-ir";
import { decideFromBundle, v2Call } from "../scripts/lib/v2-decision.mjs";

const statement = (id, match, effect) => ({
  id,
  subject: null,
  conditions: [],
  expiresAt: "never",
  provenance: {
    ruleKey: match.tool ?? match.capability,
    variant: 0,
    source: "yaml",
    layer: "agent",
  },
  match: match.tool ? { ...match, keyTier: "exact", order: 0 } : match,
  effect,
});

const document = (statements) => ({
  schemaVersion: "armor.policy.v2",
  policyId: "p-agent",
  target: { agent: "claude-code" },
  layer: "agent",
  defaults: { tools: "allow", network: "block", files: "allow", skills: "allow" },
  capture: { arguments: false, redact: [], maxBytesPerCall: 16384, sample: 1 },
  expiresAt: "never",
  statements,
});

const agent = (statements, tools = []) => ({
  policy: { policyId: "p-agent", name: "mcp-rules", document: document(statements) },
  tools,
  members: [],
});

const decide = (bundleAgent, toolName) =>
  decideFromBundle(ir, bundleAgent, { ...v2Call(toolName), arguments: {} }).action;

test("a qualified block rule blocks the call on its own server", () => {
  const rules = agent([statement("st-q", { tool: "mcp__echo__shout" }, "block")]);
  assert.equal(decide(rules, "mcp__echo__shout"), "block");
});

test("a qualified block rule leaves the same tool name on another server alone", () => {
  const rules = agent([statement("st-q", { tool: "mcp__echo__shout" }, "block")]);
  assert.equal(decide(rules, "mcp__other__shout"), "allow");
});

test("a qualified rule matches a plugin MCP call by its server", () => {
  const rules = agent([statement("st-q", { tool: "mcp__echo__shout" }, "block")]);
  assert.equal(decide(rules, "mcp__plugin_acme_echo__shout"), "block");
});

test("a call never takes another server's row as its own, and holds when that row is stricter", () => {
  const rules = agent(
    [statement("st-d", { capability: "destructive" }, "block")],
    [
      {
        name: "shout",
        qualifiedName: "mcp__other__shout",
        server: "other",
        schemaHash: null,
        capabilities: ["destructive"],
      },
    ]
  );
  assert.equal(decide(rules, "mcp__echo__shout"), "hold");
  assert.equal(decide(rules, "mcp__other__shout"), "block");
});

test("a call on a server with no inventory row is allowed when no other server's row is stricter", () => {
  const rules = agent(
    [statement("st-d", { capability: "destructive" }, "block")],
    [
      {
        name: "shout",
        qualifiedName: "mcp__other__shout",
        server: "other",
        schemaHash: null,
        capabilities: [],
      },
    ]
  );
  assert.equal(decide(rules, "mcp__echo__shout"), "allow");
});
