import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultProfile, profileSchema } from "../src/chat-profiles.js";
import { captureReplyTarget, formatReply } from "../src/zalo-replies.js";
const original = {
  uidFrom: "3333333333333333333",
  dName: "An 😀",
  msgId: "9223372036854775801",
  cliMsgId: "1793512345678",
  ts: "1793512345679",
  content: "Câu hỏi gốc",
  ttl: 0,
  secret: "not captured",
};
test("reply settings validate and legacy profiles retain safe defaults", () => {
  assert.equal(defaultProfile().sequentialReplies, true);
  assert.equal(defaultProfile().replyTarget, "none");
  assert.throws(() => profileSchema.parse({ sequentialReplies: "true" }));
  assert.throws(() => profileSchema.parse({ replyTarget: "arbitrary" }));
});
test("capture preserves large message IDs as strings and only persists required metadata", () => {
  const t = captureReplyTarget(original) as any;
  assert.equal(t.quote.msgId, original.msgId);
  assert.equal(t.senderId, original.uidFrom);
  assert.equal(t.secret, undefined);
  assert.equal(t.content, undefined);
  assert.equal(
    (captureReplyTarget({ ...original, cliMsgId: undefined }) as any).quote,
    undefined,
  );
});
test("Tag + Reply targets the original user/message and shifts native color offsets correctly", () => {
  const profile = {
    ...defaultProfile(),
    replyTarget: "both" as const,
    presentation: "color" as const,
    emoji: true,
  };
  const result = formatReply(
    "[GREEN]Đúng[/GREEN]",
    profile,
    captureReplyTarget(original),
    original.content,
    true,
  )[0] as any;
  assert.equal(result.msg, "@An 😀\nĐúng");
  assert.equal(result.quote.uidFrom, original.uidFrom);
  assert.equal(result.quote.msgId, original.msgId);
  assert.equal(result.quote.content, original.content);
  assert.deepEqual(result.mentions, [
    { uid: original.uidFrom, pos: 0, len: "@An 😀".length },
  ]);
  assert.equal(result.styles[0].start, "@An 😀\n".length);
});
test("long answers quote the same question in every chunk and tag only once", () => {
  const result = formatReply(
    "a".repeat(4000),
    { ...defaultProfile(), replyTarget: "both" },
    captureReplyTarget(original),
    original.content,
    true,
  ) as any[];
  assert.ok(result.length > 1);
  for (const p of result) {
    assert.ok(p.msg.length <= 1800);
    assert.equal(p.quote.msgId, original.msgId);
  }
  assert.equal(result.filter((p) => p.mentions?.length).length, 1);
});
test("missing old quote metadata falls back to group tag; DM tags use native Reply; off stays plain", () => {
  const target = captureReplyTarget({ ...original, cliMsgId: undefined });
  const fallback = formatReply(
    "Trả lời",
    { ...defaultProfile(), replyTarget: "reply" },
    target,
    original.content,
    true,
  )[0] as any;
  assert.equal(fallback.quote, undefined);
  assert.equal(fallback.mentions[0].uid, original.uidFrom);
  const dm = formatReply(
    "Trả lời",
    { ...defaultProfile(), replyTarget: "tag" },
    captureReplyTarget(original),
    original.content,
    false,
  )[0] as any;
  assert.equal(dm.mentions, undefined);
  assert.equal(dm.quote.msgId, original.msgId);
  assert.deepEqual(
    formatReply(
      "Trả lời",
      defaultProfile(),
      captureReplyTarget(original),
      original.content,
      true,
    ),
    ["Trả lời"],
  );
});
