import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultProfile } from "../src/chat-profiles.js";
import { synthesisMessages } from "../src/handoff.js";
test("synthesis retains personality, requested length, exact evidence and incomplete status in a compact envelope", () => {
  const p = {
    ...defaultProfile(),
    personality: "Xưng em, gọi anh",
    quality: "long" as const,
  };
  const evidence =
    "Giá A 24.950 VNĐ/lít, hiệu lực 01/11/2026. Nguồn: https://example.com/report";
  const messages = synthesisMessages(
    p,
    "Câu hỏi hiện tại",
    { text: evidence, incomplete: true },
    "Tra nguồn",
  );
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /Xưng em, gọi anh/);
  assert.match(messages[0].content, /trình bày chi tiết/);
  assert.match(messages[0].content, /Không tra cứu lại/);
  const data = JSON.parse(messages[1].content);
  assert.equal(data.evidence, evidence);
  assert.equal(data.question, "Câu hỏi hiện tại");
  assert.equal(data.status, "incomplete");
  assert.equal(p.quality, "long");
});
