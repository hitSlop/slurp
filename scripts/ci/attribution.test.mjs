import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantIdentity, attributionLines, protectedPullBase } from "./attribution.mjs";

const found = (text) => attributionLines(text, "t").length;

test("assistant co-author trailers are refused, human ones are welcome", () => {
  assert.equal(found("Co-Authored-By: Claude Opus 4 <noreply@anthropic.com>"), 1);
  assert.equal(found("co-authored-by: Claude Code <someone@example.com>"), 1);
  assert.equal(found("Co-authored-by: Codex <codex@openai.com>"), 1);
  assert.equal(found("Co-authored-by: Copilot <198982749+Copilot[bot]@users.noreply.github.com>"), 1, "the Copilot bot is an assistant");
  assert.equal(found("Co-authored-by: Claude Smith <claude@smithfamily.example>"), 0, "a human named Claude is fine");
  assert.equal(found("Co-authored-by: Ada Lovelace <ada@example.com>"), 0);
});

test("generated-by lines and session links are refused; prose mentioning tools is not", () => {
  assert.equal(found("🤖 Generated with [Claude Code](https://claude.com/claude-code)"), 1);
  assert.equal(found("Generated with Claude Code"), 1);
  assert.equal(found("claude-session: https://claude.ai/code/session_123"), 1);
  assert.equal(found("I used Claude to brainstorm names for this"), 0);
  assert.equal(found("Generated with the project's own code generator"), 0);
});

test("assistant identities need a recognized name or bot address", () => {
  assert.equal(assistantIdentity("Claude Code", "x@example.com"), true);
  assert.equal(assistantIdentity("Someone", "noreply@anthropic.com"), true);
  assert.equal(assistantIdentity("Jordan Howlett", "jordan@howlett.io"), false);
});

test("only master and hotfix branches are protected", () => {
  assert.equal(protectedPullBase("master"), true);
  assert.equal(protectedPullBase("hotfix/1.2"), true);
  assert.equal(protectedPullBase("main"), false);
  assert.equal(protectedPullBase("feature/x"), false);
});
