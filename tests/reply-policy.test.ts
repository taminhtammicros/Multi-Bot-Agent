import { test } from "node:test";
import assert from "node:assert/strict";
import { isBotMentioned, permitsReply } from "../src/reply-policy.js";
test("tag mode needs a structured mention of the exact bot UID", () => {
  const bot = "1111111111111111111";
  assert.equal(isBotMentioned({ data: { content: "@Bot hello" } }, bot), false);
  assert.equal(
    isBotMentioned(
      { data: { mentions: [{ uid: "-1" }, { uid: "2222222222222222222" }] } },
      bot,
    ),
    false,
  );
  assert.equal(
    isBotMentioned({ data: { mentions: [{ uid: bot }] } }, bot),
    true,
  );
  assert.equal(permitsReply("mention", false), false);
  assert.equal(permitsReply("mention", true), true);
  assert.equal(permitsReply("silent", true), false);
  assert.equal(permitsReply("all", false), true);
});
