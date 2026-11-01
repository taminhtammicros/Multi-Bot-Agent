import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1077, height: 609 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const parent = {
  id: "11111111-1111-4111-8111-111111111111",
  agent: "hermes",
  status: "review",
  request: "Tra nguồn chính thức",
  error: "Lượt cần đối soát",
  created_at: "2026-11-01T16:14:03Z",
};
const child = {
  id: "22222222-2222-4222-8222-222222222222",
  parent_id: parent.id,
  agent: "openclaw",
  status: "review",
  request: "Tra nguồn <script>unsafe()</script>",
  result: null,
  error: "OpenClaw chưa trả kết quả xác thực",
  created_at: "2026-11-01T16:14:19Z",
  updated_at: "2026-11-01T16:14:55Z",
};
await page.route("**/api/tasks", (r) => r.fulfill({ json: [parent] }));
await page.route("**/api/tasks/" + parent.id, (r) =>
  r.fulfill({
    json: {
      task: parent,
      runs: [
        { agent: "hermes", status: "completed", created_at: parent.created_at },
      ],
      children: [child],
      childRuns: [
        {
          task_id: child.id,
          agent: "openclaw",
          status: "unknown",
          created_at: child.created_at,
          finished_at: child.updated_at,
          error: child.error,
        },
      ],
    },
  }),
);
try {
  await page.goto("http://127.0.0.1:3890/#tasks");
  await page
    .getByLabel("Mã quản trị")
    .fill((await readFile("data/admin-token", "utf8")).trim());
  await page.getByRole("button", { name: "Đăng nhập dashboard" }).click();
  await page.locator('[data-task="' + parent.id + '"]').click();
  const modal = page.locator("dialog[open]");
  await modal
    .getByRole("heading", { name: "Hermes → OpenClaw → Hermes" })
    .waitFor();
  assert.ok(
    (await modal.textContent()).includes("Tra nguồn <script>unsafe()</script>"),
  );
  assert.ok((await modal.textContent()).includes("36.0 giây"));
  assert.ok((await modal.textContent()).includes("Chưa có kết quả xác nhận"));
  assert.equal(await modal.locator("script").count(), 0);
  await page.setViewportSize({ width: 663, height: 609 });
  assert.ok(await modal.isVisible());
  assert.deepEqual(errors, []);
  console.log(
    "Delegation detail UI: child request, result/error, timestamps, runtime, escaping and mobile passed.",
  );
} finally {
  await browser.close();
}
