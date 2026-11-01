import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const b = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await b.newPage({ viewport: { width: 1077, height: 609 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const data = {
  accountId: "111",
  groupsEnabled: false,
  contacts: [
    {
      uid: "3333333333333333333",
      kind: "dm",
      display_name: "DM person",
      allowed: true,
      message_count: 2,
    },
    {
      uid: "4444444444444444444",
      kind: "group",
      display_name: "Test group",
      allowed: false,
      message_count: 1,
    },
  ],
};
const calls = [];
await page.route("**/api/zalo/contacts", (r) => r.fulfill({ json: data }));
await page.route("**/api/zalo/groups/**", async (r) => {
  const req = r.request(),
    path = new URL(req.url()).pathname;
  if (path.endsWith("/sync")) {
    data.contacts.push({
      uid: "9999999999999999999",
      kind: "group",
      display_name: "New synced group",
      allowed: false,
      message_count: 0,
    });
    await r.fulfill({ json: { ok: true, count: 2 } });
    return;
  }
  const id = path.match(/groups\/(\d+)\/access$/)?.[1];
  assert.ok(id);
  const body = req.postDataJSON();
  assert.equal(body.accountId, "111");
  calls.push({ id, ...body });
  let row = data.contacts.find((c) => c.uid === id && c.kind === "group");
  if (!row) {
    row = {
      uid: id,
      kind: "group",
      display_name: "Manual group",
      message_count: 0,
    };
    data.contacts.push(row);
  }
  row.allowed = body.allowed;
  await r.fulfill({ json: { ok: true, groupsEnabled: data.groupsEnabled } });
});
await page.route("**/api/zalo/groups-enabled", async (r) => {
  const body = r.request().postDataJSON();
  assert.equal(body.accountId, "111");
  data.groupsEnabled = body.enabled;
  await r.fulfill({ json: { ok: true, groupsEnabled: data.groupsEnabled } });
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
  const panel = page.locator("#dm-contacts");
  await panel.locator('[data-contact-kind="group"]').click();
  assert.equal(await panel.locator("tbody tr").count(), 1);
  await panel
    .getByRole("button", { name: "Cho phép nhóm", exact: true })
    .click();
  await panel.getByText("Đã cấp quyền nhóm", { exact: true }).waitFor();
  assert.equal(data.groupsEnabled, false);
  assert.equal(calls[0].id, "4444444444444444444");
  assert.ok(
    await panel.getByText("Phản hồi nhóm đang tắt", { exact: true }).count(),
  );
  await page.getByLabel("Bật phản hồi trong các nhóm đã cấp quyền").check();
  await page.waitForFunction(
    () => document.querySelector("#groups-enabled")?.checked,
  );
  assert.equal(data.groupsEnabled, true);
  await panel
    .getByRole("button", { name: "Thu hồi quyền", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Cho phép nhóm", exact: true })
    .waitFor();
  assert.equal(data.contacts.find((c) => c.kind === "dm").allowed, true);
  assert.equal(calls.at(-1).allowed, false);
  await panel
    .getByRole("button", { name: "Đồng bộ nhóm", exact: true })
    .click();
  await panel.getByText("New synced group", { exact: true }).waitFor();
  assert.equal(
    data.contacts.find((c) => c.uid === "9999999999999999999").allowed,
    false,
  );
  await panel.getByRole("button", { name: "Thêm ID", exact: false }).click();
  await page.locator("dialog").waitFor({ state: "visible" });
  await page
    .locator("dialog")
    .getByLabel("Loại hội thoại", { exact: true })
    .selectOption("group");
  await page
    .getByLabel("ID người dùng hoặc nhóm", { exact: true })
    .fill("8888888888888888888");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Cấp quyền", exact: true })
    .click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  assert.equal(calls.at(-1).id, "8888888888888888888");
  const stale = await page.request.put(
    "http://127.0.0.1:3890/api/zalo/groups/4444444444444444444/access",
    { data: { accountId: "222", allowed: true } },
  );
  assert.equal(stale.status(), 409);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: group discovery/filtering, separate group permission, explicit global switch, membership sync, manual group ID and stale-account guard at 1077x609. Live permissions unchanged.",
  );
} finally {
  await b.close();
}
