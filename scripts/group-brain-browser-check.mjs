import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
const errors = [],
  mutations = [];
page.on("pageerror", (e) => errors.push(e.message));
const topic = "11111111-1111-4111-8111-111111111111",
  fact = "22222222-2222-4222-8222-222222222222",
  record = "33333333-3333-4333-8333-333333333333";
const profile = {
  personality: "",
  brain: "auto",
  model: "",
  provider: "",
  quality: "balanced",
  handoffSynthesis: "fast",
  openClawSupport: true,
  presentation: "plain",
  emoji: false,
  sequentialReplies: true,
  replyTarget: "none",
  systemCommands: true,
  deniedCommands: "",
  welcome: "",
  groupMemoryEnabled: true,
  groupSummaryMinutes: 15,
};
let saved;
await page.route("**/api/zalo/contacts", (r) =>
  r.fulfill({
    json: {
      accountId: "111",
      groupsEnabled: true,
      contacts: [
        {
          uid: "222",
          kind: "group",
          display_name: "Nhóm kiểm thử",
          allowed: true,
          mode: "mention",
        },
      ],
    },
  }),
);
await page.route("**/api/chat-profile/**", async (r) => {
  const req = r.request(),
    path = new URL(req.url()).pathname;
  if (req.method() !== "GET")
    mutations.push({ path, body: req.postDataJSON() });
  if (path.includes("/brain"))
    return r.fulfill({
      json: {
        counts: { total: "3", pending: "1", noise: "0" },
        job: {
          last_success_at: new Date().toISOString(),
          next_run_at: new Date().toISOString(),
        },
        topics: [
          {
            id: topic,
            title: "Bàn giao",
            summary: "Cần xác nhận deadline",
            status: "active",
            revision: 1,
          },
        ],
        facts: [
          {
            id: fact,
            category: "deadline",
            content: "Giao thứ sáu",
            status: "proposed",
            topic_id: topic,
            valid_from: new Date().toISOString(),
            conflicts: [],
            sources: [
              {
                id: record,
                sender: "An",
                content: "<script>window.LEAK=true</script> Chốt giao thứ sáu",
                at: new Date().toISOString(),
              },
            ],
          },
        ],
        records: [
          {
            id: record,
            sender_name: "An",
            content: "Chốt giao thứ sáu",
            occurred_at: new Date().toISOString(),
            noise: false,
          },
        ],
        overview: { summary: "Nhóm đang chuẩn bị bàn giao", revision: 1 },
      },
    });
  if (req.method() === "PUT") saved = req.postDataJSON();
  return r.fulfill({ json: { profile, sources: [], guard: { ready: true } } });
});
try {
  await page.goto("http://127.0.0.1:3890/#channels");
  await page
    .getByLabel("Mã quản trị")
    .fill((await readFile("data/admin-token", "utf8")).trim());
  await page.getByRole("button", { name: "Đăng nhập dashboard" }).click();
  await page.locator('[data-chat-settings][data-chat-kind="group"]').click();
  const dialog = page.locator("dialog[open]");
  await dialog.locator('[data-profile-tab="brain"]').click();
  await dialog.getByRole("heading", { name: "Trí nhớ riêng nhóm" }).waitFor();
  assert.match(
    await dialog.locator("#brain-view").innerText(),
    /AI trích xuất/,
  );
  assert.ok(await dialog.locator('[name="groupMemoryEnabled"]').isChecked());
  await dialog.locator('[name="groupSummaryMinutes"]').fill("30");
  await dialog.locator("#brain-summarize").click();
  await dialog.locator("#brain-rebuild").click();
  await dialog.locator("#brain-view details").nth(1).locator("summary").click();
  await dialog.locator("[data-fact-confirm]").click();
  assert.equal(await page.evaluate(() => window.LEAK), undefined);
  await dialog.locator('[data-profile-tab="connection"]').click();
  assert.ok(await dialog.locator('[name="brain"]').isDisabled());
  await dialog.locator('[data-profile-tab="brain"]').click();
  await dialog.getByRole("button", { name: "Lưu cấu hình hội thoại" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#profile-save-state")
      ?.textContent.startsWith("Đã lưu"),
  );
  assert.equal(saved.profile.groupSummaryMinutes, 30);
  assert.equal(saved.profile.brain, "auto");
  assert.equal(saved.profile.systemCommands, true);
  assert.ok(mutations.some((m) => m.path.endsWith("/brain/summarize")));
  assert.ok(mutations.some((m) => m.path.endsWith("/brain/rebuild")));
  assert.ok(mutations.some((m) => m.body.status === "confirmed"));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/group-brain-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "Group brain browser PASS: scoped UI, evidence escaping, summary/rebuild, confirmation, saved cadence, private model controls, mobile.",
  );
} finally {
  await browser.close();
}
