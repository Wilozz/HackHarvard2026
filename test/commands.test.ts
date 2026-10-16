import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../src/agent/commands";

const group = (text: string, phase: Parameters<typeof parseCommand>[1]["phase"] = "idle") =>
  parseCommand(text, { agentName: "Tripchat", requireMention: true, phase });

test("ignores chatter that doesn't mention the agent", () => {
  assert.deepEqual(group("we should plan it soon"), { kind: "none" });
  assert.deepEqual(group("I approve of this restaurant"), { kind: "none" });
});

test("recognizes mentioned commands", () => {
  assert.deepEqual(group("@Tripchat plan it"), { kind: "plan", request: "plan it" });
  assert.deepEqual(group("hey @tripchat, plan a trip for December"), { kind: "plan", request: "hey plan a trip for December" });
  assert.deepEqual(group("@Tripchat forget"), { kind: "forget" });
  assert.deepEqual(group("@Tripchat book it", "confirming"), { kind: "book" });
  assert.deepEqual(group("@Tripchat I’ll pay"), { kind: "payer" });
  assert.deepEqual(group("@Tripchat status"), { kind: "status" });
  assert.deepEqual(group("@Tripchat"), { kind: "help" });
  assert.deepEqual(group("@Tripchat what did Matias say about the Airbnb?"), {
    kind: "ask",
    question: "what did Matias say about the Airbnb?",
  });
});

test("votes work without a mention only while voting", () => {
  assert.deepEqual(group("vote 2", "voting"), { kind: "vote", option: 2 });
  assert.deepEqual(group("I vote for #1!", "voting"), { kind: "vote", option: 1 });
  assert.deepEqual(group("vote 2", "idle"), { kind: "none" });
  assert.deepEqual(group("@Tripchat go with 3", "idle"), { kind: "vote", option: 3 });
});

test("a bare approve counts only while collecting shares", () => {
  assert.deepEqual(group("approve", "collecting"), { kind: "approve" });
  assert.deepEqual(group("Approved!", "collecting"), { kind: "approve" });
  assert.deepEqual(group("approve", "voting"), { kind: "none" });
  assert.deepEqual(group("approve the plan but not the hotel", "collecting"), { kind: "none" });
  assert.deepEqual(group("@Tripchat I approve", "collecting"), { kind: "approve" });
});

test("in a DM every message is for the agent", () => {
  assert.deepEqual(parseCommand("plan it", { agentName: "Tripchat", requireMention: false, phase: "idle" }), {
    kind: "plan",
    request: "plan it",
  });
});
