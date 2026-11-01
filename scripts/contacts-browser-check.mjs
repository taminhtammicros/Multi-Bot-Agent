import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 820, height: 875 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const contacts = [
  {
    uid: "3333333333333333333",
    display_name: "Người được phép",
    allowed: true,
    last_seen: new Date().toISOString(),
    message_count: 2,
  },
  {
    uid: "9990000000000000001",
    display_name: "Đặng Minh <img src=x onerror=alert(1)>",
    allowed: false,
    last_seen: new Date().toISOString(),
    message_count: 1,
  },
];
const calls = [];
await page.route("**/api/zalo/contacts**", async (route) => {
  const req = route.request(),
    path = new URL(req.url()).pathname;
  if (req.method() === "GET") {
    await route.fulfill({ json: { accountId: "111", contacts } });
    return;
  }
  const match = path.match(/contacts\/(\d+)\/access$/);
  assert.ok(match);
  const body = req.postDataJSON();
  assert.equal(body.accountId, "111");
  calls.push({ uid: match[1], allowed: body.allowed });
  let contact = contacts.find((c) => c.uid === match[1]);
  if (!contact) {
    contact = {
      uid: match[1],
      display_name: "",
      last_seen: null,
      message_count: 0,
    };
    contacts.push(contact);
  }
  contact.allowed = body.allowed;
  await route.fulfill({ json: { ok: true } });
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
  assert.equal(
    await panel.locator("td img").count(),
    0,
    "Contact names must be escaped",
  );
  await panel
    .getByRole("button", { name: "Chưa cấp quyền", exact: false })
    .click();
  assert.equal(await panel.locator("tbody tr").count(), 1);
  await panel.getByRole("button", { name: "Cho phép DM", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#dm-contacts")
      ?.innerText.includes("Chưa cấp quyền (0)"),
  );
  assert.deepEqual(calls[0], { uid: "9990000000000000001", allowed: true });
  await panel.getByRole("button", { name: "Được phép", exact: false }).click();
  await panel
    .locator("tr")
    .filter({ hasText: "9990000000000000001" })
    .getByRole("button", { name: "Thu hồi quyền" })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector("#dm-contacts")
      ?.innerText.includes("Chưa cấp quyền (1)"),
  );
  assert.equal(calls[1].allowed, false);
  await panel.getByRole("button", { name: "Tất cả", exact: false }).click();
  const search = page.getByLabel("Tìm người dùng hoặc nhóm");
  await search.fill("dang minh");
  assert.equal(await panel.locator("tbody tr").count(), 1);
  await page.waitForTimeout(5500);
  assert.equal(await search.inputValue(), "dang minh");
  await search.fill("");
  await panel.getByRole("button", { name: "Thêm ID", exact: false }).click();
  await page
    .getByLabel("ID người dùng hoặc nhóm", { exact: true })
    .fill("2222222222222222222");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Cấp quyền", exact: true })
    .click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(calls.at(-1), { uid: "2222222222222222222", allowed: true });
  const live = await page.request
    .get("http://127.0.0.1:3890/api/zalo")
    .then((r) => r.json());
  const stale = await page.request.put(
    "http://127.0.0.1:3890/api/zalo/contacts/9990000000000000001/access",
    { data: { accountId: "222", allowed: true } },
  );
  assert.equal(stale.status(), 409);
  const self = await page.request.put(
    "http://127.0.0.1:3890/api/zalo/contacts/" + live.accountId + "/access",
    { data: { accountId: live.accountId, allowed: true } },
  );
  assert.equal(self.status(), 400);
  const anonymous = await browser.newContext();
  assert.equal(
    (
      await anonymous.request.get("http://127.0.0.1:3890/api/zalo/contacts")
    ).status(),
    401,
  );
  await anonymous.close();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: contact list, permission filters, grant/revoke, search retention, 19-digit manual UID, escaped names, mobile, auth and stale-account guard. Real allowlist unchanged.",
  );
} finally {
  await browser.close();
}
