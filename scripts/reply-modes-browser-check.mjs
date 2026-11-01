import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1077, height: 609 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shared = "7777777777777777777",
  pending = "8888888888888888888";
const data = {
  accountId: "111",
  groupsEnabled: true,
  contacts: [
    {
      uid: shared,
      kind: "dm",
      display_name: "DM person",
      allowed: true,
      mode: "all",
    },
    {
      uid: shared,
      kind: "group",
      display_name: "Tagged group",
      allowed: true,
      mode: "mention",
    },
    {
      uid: pending,
      kind: "group",
      display_name: "Quiet group",
      allowed: false,
      mode: "silent",
    },
  ],
};
const calls = [];
let rejectNext = false;
await page.route("**/api/zalo/contacts", (r) => r.fulfill({ json: data }));
await page.route("**/api/zalo/reply-mode/**", async (route) => {
  const req = route.request(),
    body = req.postDataJSON(),
    match = new URL(req.url()).pathname.match(/reply-mode\/(dm|group)\/(\d+)$/);
  assert.ok(match);
  assert.equal(body.accountId, "111");
  assert.ok(["silent", "mention", "all"].includes(body.mode));
  calls.push({ kind: match[1], uid: match[2], mode: body.mode });
  if (rejectNext) {
    rejectNext = false;
    await route.fulfill({ status: 503, json: { error: "Test save failure" } });
    return;
  }
  const c = data.contacts.find(
    (c) => c.kind === match[1] && c.uid === match[2],
  );
  c.mode = body.mode;
  c.allowed = body.mode !== "silent";
  await route.fulfill({ json: { ok: true, mode: body.mode } });
});
try {
  await page.goto("http://127.0.0.1:3890/#connections");
  await page
    .getByLabel("Mã quản trị")
    .fill((await readFile("data/admin-token", "utf8")).trim());
  await page.getByRole("button", { name: "Đăng nhập dashboard" }).click();
  await page
    .getByRole("heading", { name: "Quyền trò chuyện với bot" })
    .waitFor();
  const selector = (kind, id) =>
    `[data-reply-mode][data-reply-kind="${kind}"][data-reply-uid="${id}"]`;
  const group = page.locator(selector("group", shared)),
    dm = page.locator(selector("dm", shared)),
    quiet = page.locator(selector("group", pending));
  assert.equal(await page.locator("[data-reply-mode]").count(), 3);
  assert.deepEqual(await group.locator("option").allTextContents(), [
    "Tag mới trả lời",
    "Im lặng",
    "Hóng chuyện",
  ]);
  assert.equal(await group.inputValue(), "mention");
  assert.equal(await quiet.inputValue(), "silent");
  await group.selectOption("silent");
  await page.waitForFunction(
    (s) => document.querySelector(s)?.dataset.previousMode === "silent",
    selector("group", shared),
  );
  assert.equal(await dm.inputValue(), "all");
  assert.deepEqual(calls.at(-1), {
    kind: "group",
    uid: shared,
    mode: "silent",
  });
  await group.selectOption("mention");
  await page.waitForFunction(
    (s) => document.querySelector(s)?.dataset.previousMode === "mention",
    selector("group", shared),
  );
  rejectNext = true;
  await group.selectOption("all");
  await page.waitForFunction(
    (s) => {
      const el = document.querySelector(s);
      return el && !el.disabled && el.value === "mention";
    },
    selector("group", shared),
  );
  assert.equal(
    data.contacts.find((c) => c.kind === "group" && c.uid === shared).mode,
    "mention",
  );
  await quiet.selectOption("all");
  await page.waitForFunction(
    (s) => document.querySelector(s)?.dataset.previousMode === "all",
    selector("group", pending),
  );
  assert.equal(data.contacts.find((c) => c.uid === pending).allowed, true);
  await dm.selectOption("mention");
  await page.waitForFunction(
    (s) => document.querySelector(s)?.dataset.previousMode === "mention",
    selector("dm", shared),
  );
  await page.waitForTimeout(5500);
  assert.equal(await dm.inputValue(), "mention");
  assert.equal(await quiet.inputValue(), "all");
  const current = await page.request
    .get("http://127.0.0.1:3890/api/zalo")
    .then((r) => r.json());
  const invalid = await page.request.put(
    "http://127.0.0.1:3890/api/zalo/reply-mode/group/" + shared,
    { data: { accountId: current.accountId, mode: "invalid-mode" } },
  );
  assert.equal(invalid.status(), 400);
  const stale = await page.request.put(
    "http://127.0.0.1:3890/api/zalo/reply-mode/group/" + shared,
    { data: { accountId: "222", mode: "all" } },
  );
  assert.equal(stale.status(), 409);
  const anonymous = await browser.newContext();
  assert.equal(
    (
      await anonymous.request.put(
        "http://127.0.0.1:3890/api/zalo/reply-mode/group/" + shared,
        { data: { accountId: "111", mode: "all" } },
      )
    ).status(),
    401,
  );
  await anonymous.close();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: three reply modes on each DM/group row, kind isolation, immediate save, error rollback, refresh persistence, API validation and responsive layout. Live permissions untouched.",
  );
} finally {
  await browser.close();
}
