import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  groupScope,
  isNoise,
  parseExtraction,
  sourceTime,
} from "../src/group-brain.js";
test("group scope requires exact account and group, with no default scope", () => {
  assert.notEqual(
    groupScope({ accountId: "1", groupId: "2" }),
    groupScope({ accountId: "3", groupId: "2" }),
  );
  for (const s of [
    { accountId: "", groupId: "2" },
    { accountId: "1", groupId: "2:3" },
    { accountId: "1", groupId: "" },
  ])
    assert.throws(() => groupScope(s));
});
test("noise filtering preserves short decisions, negations, dates and replies", () => {
  for (const text of [
    "Chốt",
    "Không duyệt",
    "Mai giao",
    "OK",
    "2/11",
    "Dừng",
    "Đừng làm",
  ])
    assert.equal(isNoise(text), false, text);
  assert.equal(isNoise("👍"), true);
  assert.equal(isNoise("cảm ơn"), true);
  assert.equal(isNoise("👍", "123"), false);
});
test("extraction rejects foreign sources, invented quotes, bot evidence and omitted messages", () => {
  const id = randomUUID(),
    foreign = randomUUID();
  const records = [
    { id, seq: "1", role: "user", content: "Chốt giao thứ sáu" },
  ];
  const good = {
    topics: [
      {
        key: "t",
        existingId: null,
        title: "Bàn giao",
        summary: "Đề xuất",
        recordIds: [id],
        facts: [
          {
            category: "deadline",
            content: "Giao thứ sáu",
            evidence: [{ recordId: id, quote: "Chốt giao thứ sáu" }],
            contradicts: [],
          },
        ],
      },
    ],
    noiseIds: [],
  };
  const parse = (value: any, rs = records) =>
    parseExtraction(JSON.stringify(value), rs, new Set(), new Set());
  assert.equal(parse(good).topics.length, 1);
  const clone = () => structuredClone(good);
  let bad = clone();
  bad.topics[0].facts[0].evidence[0].recordId = foreign;
  assert.throws(() => parse(bad));
  bad = clone();
  bad.topics[0].facts[0].evidence[0].quote = "Chốt giao thứ hai";
  assert.throws(() => parse(bad));
  bad = clone();
  bad.topics[0].existingId = foreign as any;
  assert.throws(() => parse(bad));
  bad = clone();
  bad.topics[0].facts[0].contradicts = [foreign] as any;
  assert.throws(() => parse(bad));
  assert.throws(() => parse(good, [{ ...records[0], role: "assistant" }]));
  assert.throws(() => parse({ topics: [], noiseIds: [] }));
  assert.throws(() =>
    parse({ topics: [], noiseIds: [id] }, [
      { ...records[0], classification: "manual_work" },
    ] as any),
  );
});
test("source timestamps accept seconds and milliseconds, reject invalid/future dates", () => {
  const ms = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(sourceTime(ms).getTime(), ms);
  assert.equal(sourceTime(ms / 1000).getTime(), ms);
  assert.ok(Math.abs(sourceTime("invalid").getTime() - Date.now()) < 1000);
});
