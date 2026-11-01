import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 820, height: 875 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
// Mock only the QR lifecycle: never disconnect or replace a real Zalo session.
let state = { status: "disconnected", qr: null, error: null, accountId: null },
  attempts = 0;
const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
await page.route("**/api/zalo**", async (route) => {
  const req = route.request();
  if (!["/api/zalo", "/api/zalo/connect"].includes(new URL(req.url()).pathname)) {
    await route.continue();
    return;
  }
  if (new URL(req.url()).pathname === "/api/zalo/connect") {
    assert.equal(req.method(), "POST");
    assert.equal(
      req.headers()["content-type"],
      undefined,
      "Bodyless POST must not declare JSON",
    );
    assert.equal(req.postData(), null);
    attempts++;
    state = { status: "qr", qr: pixel, error: null, accountId: null };
    await route.fulfill({ json: { ok: true } });
  } else
    await route.fulfill({
      json: {
        ...state,
        policy: { allowUsers: [], allowGroups: [], groupsEnabled: false },
      },
    });
});
try {
  await page.goto("http://127.0.0.1:3890/#connections");
  await page
    .getByLabel("Mã quản trị")
    .fill((await readFile("data/admin-token", "utf8")).trim());
  await page.getByRole("button", { name: "Đăng nhập dashboard" }).click();
  // The real account may already be connected; its card then says Quản lý Zalo.
  await page.locator("[data-zalo]").click();
  await page.locator("dialog").waitFor({ state: "visible" });
  const qr = page.getByAltText("Mã QR đăng nhập Zalo");
  await qr.waitFor({ state: "visible" });
  assert.equal(
    attempts,
    1,
    "Opening the dialog should automatically request QR",
  );
  assert.ok(await qr.evaluate((img) => img.complete && img.naturalWidth > 0));
  assert.equal(await page.locator("#start-qr").isDisabled(), true);
  state = {
    status: "disconnected",
    qr: null,
    error: "Mã QR đã hết hạn. Bấm Thử lại để tạo mã mới.",
    accountId: null,
  };
  const retry = page.getByRole("button", {
    name: "Thử lại — tạo QR mới",
    exact: true,
  });
  await retry.waitFor();
  await page.waitForFunction(
    () => !document.querySelector("#start-qr").disabled,
  );
  await retry.click();
  await qr.waitFor({ state: "visible" });
  assert.equal(attempts, 2);
  state = {
    status: "disconnected",
    qr: null,
    error: "Đăng nhập bị từ chối trên điện thoại.",
    accountId: null,
  };
  await retry.waitFor();
  await page.waitForFunction(
    () => !document.querySelector("#start-qr").disabled,
  );
  await retry.click();
  await qr.waitFor({ state: "visible" });
  assert.equal(attempts, 3);
  await page.getByRole("button", { name: "Đóng", exact: true }).click();
  await page.locator("[data-zalo]").click();
  await qr.waitFor({ state: "visible" });
  assert.equal(attempts, 3, "Reopening should reuse the active QR");
  state = {
    status: "connected",
    qr: null,
    error: null,
    accountId: "test-account",
  };
  await page.locator("dialog").waitFor({ state: "hidden" });
  const check = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/agents/hermes/check") &&
      r.request().method() === "POST",
  );
  await page.locator('[data-check="hermes"]').click();
  assert.equal(
    (await check).status(),
    200,
    "Bodyless agent check should reach backend",
  );
  const logout = page.waitForResponse((r) => r.url().endsWith("/api/logout"));
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  assert.equal((await logout).status(), 200);
  await page.getByLabel("Mã quản trị").waitFor();
  assert.deepEqual(pageErrors, []);
  console.log(
    "PASS: auto QR, image display, expiry/rejection retry, reuse active QR, connected close, real agent check and logout at 820x875; real Zalo session preserved.",
  );
} finally {
  await browser.close();
}
