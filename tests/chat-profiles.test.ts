import { test } from "node:test";
import assert from "node:assert/strict";
import { profileSchema, profileInstructions } from "../src/chat-profiles.js";
import {
  styledText,
  splitFormatted,
  splitMentioned,
  welcomeMessage,
} from "../src/zalo-format.js";
import { extractText, safeLocalPath, webText } from "../src/knowledge.js";
import { TextStyle } from "zca-js";

test("profile limits and quality instructions are validated", () => {
  assert.throws(() => profileSchema.parse({ personality: "x".repeat(2001) }));
  assert.throws(() => profileSchema.parse({ brain: "other" }));
  const p = profileSchema.parse({
    personality: "Xưng em, gọi người dùng là anh",
    quality: "long",
  });
  assert.equal(p.openClawSupport, true);
  assert.equal(profileSchema.parse({ openClawSupport: false }).openClawSupport, false);
  assert.match(profileInstructions(p), /Xưng em/);
  assert.match(profileInstructions(p), /Phân tích nội bộ sâu/);
});
test("native color offsets refer to visible text; plain output removes labels and emoji", () => {
  const text =
    "[GREEN]Đúng[/GREEN] và [RED]Sai[/RED] [YELLOW]Lưu ý[/YELLOW] 👍";
  const colored = styledText(text, { presentation: "color", emoji: true });
  assert.equal(colored.msg, "Đúng và Sai Lưu ý 👍");
  assert.deepEqual(colored.styles, [
    { start: 0, len: 4, st: TextStyle.Green },
    { start: 8, len: 3, st: TextStyle.Red },
    { start: 12, len: 5, st: TextStyle.Yellow },
  ]);
  const plain = styledText(text, { presentation: "plain", emoji: false });
  assert.equal(plain.msg, "Đúng và Sai Lưu ý ");
  assert.deepEqual(plain.styles, []);
});
test("long styled text keeps styles and surrogate pairs valid across chunks", () => {
  const parts = splitFormatted("[GREEN]" + "a".repeat(1799) + "😀xyz[/GREEN]", {
    presentation: "color",
    emoji: true,
  });
  assert.equal(parts.length, 2);
  assert.equal(parts[1].msg, "😀xyz");
  for (const part of parts)
    for (const s of part.styles)
      assert.ok(s.start >= 0 && s.start + s.len <= part.msg.length);
  assert.equal(parts.map((p) => p.msg).join(""), "a".repeat(1799) + "😀xyz");
});
test("welcome substitutes real mentions, deduplicates members and preserves Unicode offsets", () => {
  const w = welcomeMessage(
    "Chào {members}, đến {group}!",
    [
      { id: "123", dName: "An 😀" },
      { id: "456", dName: "Bình" },
      { id: "123", dName: "An 😀" },
    ],
    "Nhóm A",
  );
  assert.equal(w.msg, "Chào @An 😀 @Bình, đến Nhóm A!");
  assert.deepEqual(
    w.mentions.map((m) => w.msg.slice(m.pos, m.pos + m.len)),
    ["@An 😀", "@Bình"],
  );
  assert.equal(w.mentions.length, 2);
  assert.equal(
    welcomeMessage("Xin chào", [{ id: "123", dName: "An" }], "A").mentions[0]
      .pos,
    0,
  );
});
test("knowledge extracts text and refuses private URLs and filesystem secrets", async () => {
  assert.match(
    await extractText(
      Buffer.from("<html><script>secret()</script><p>Kiến thức</p></html>"),
      "test.html",
    ),
    /Kiến thức/,
  );
  assert.doesNotMatch(
    await extractText(
      Buffer.from("<script>secret()</script><p>ok</p>"),
      "test.html",
    ),
    /secret/,
  );
  await assert.rejects(extractText(Buffer.from("binary"), "test.exe"));
  await assert.rejects(safeLocalPath("/etc/passwd"));
  await assert.rejects(safeLocalPath("data/admin-token"));
  for (const url of [
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/",
    "file:///etc/passwd",
    "http://example.com:3890/",
  ])
    await assert.rejects(webText(url));
});
test("long welcome splits around mentions without cutting a member name", () => {
  const original = welcomeMessage(
    "a".repeat(1797) + "{members}" + "z".repeat(200),
    [{ id: "123", dName: "An 😀" }],
    "A",
  );
  const parts = splitMentioned(original);
  assert.equal(parts.length, 2);
  assert.equal(parts.map((p) => p.msg).join(""), original.msg);
  assert.deepEqual(parts[0].mentions, []);
  assert.equal(parts[1].mentions[0].pos, 0);
  assert.equal(parts[1].msg.slice(0, parts[1].mentions[0].len), "@An 😀");
});
