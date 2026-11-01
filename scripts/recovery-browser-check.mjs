import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 663, height: 609 } });
let mode = "retry",
  retries = 0,
  qrRequests = 0;
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
function fakeZalo(z) {
  return {
    ...z,
    status: mode === "online" ? "connected" : "disconnected",
    error:
      mode === "online"
        ? null
        : mode === "conflict"
          ? "Zalo báo kết nối trùng (3000). Đóng Zalo Web hoặc bridge khác rồi bấm Kết nối lại."
          : "Mất kết nối Zalo (1006); hệ thống sẽ tự kết nối lại.",
    recovery: {
      ...z.recovery,
      hasSession: true,
      enabled: mode !== "conflict",
      inProgress: false,
      attempts: 3,
      lastCloseCode: mode === "conflict" ? 3000 : 1006,
      lastDisconnectedAt: new Date().toISOString(),
      nextRetryAt:
        mode === "retry" ? new Date(Date.now() + 60000).toISOString() : null,
      conflict: mode === "conflict",
      requiresLogin: false,
    },
  };
}
await page.route("**/api/overview", async (route) => {
  const response = await route.fetch(),
    data = await response.json();
  data.zalo = fakeZalo(data.zalo);
  await route.fulfill({ response, json: data });
});
await page.route("**/api/zalo", async (route) => {
  const response = await route.fetch();
  await route.fulfill({ response, json: fakeZalo(await response.json()) });
});
await page.route("**/api/zalo/reconnect", async (route) => {
  assert.equal(route.request().headers()["content-type"], undefined);
  retries++;
  mode = "online";
  await route.fulfill({ json: { ok: true } });
});
await page.route("**/api/zalo/connect", async (route) => {
  qrRequests++;
  await route.fulfill({ json: { ok: true } });
});
try {
  await page.goto("http://127.0.0.1:3890/#connections");
  await page
    .getByLabel("Mã quản trị")
    .fill((await readFile("data/admin-token", "utf8")).trim());
  await page.getByRole("button", { name: "Đăng nhập dashboard" }).click();
  const panel = page
    .locator("section.card")
    .filter({
      has: page.getByRole("heading", {
        name: "Duy trì kết nối Zalo",
        exact: true,
      }),
    });
  await panel.waitFor();
  await panel.getByRole("button", { name: "Kết nối lại", exact: true }).click();
  await panel.getByText("Đã kết nối", { exact: true }).waitFor();
  assert.equal(retries, 1);
  mode = "conflict";
  await panel.getByText("Trùng phiên Zalo", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Quản lý đăng nhập" }).click();
  await page.locator("dialog").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "Đăng nhập lại bằng QR", exact: true })
    .waitFor();
  await page.waitForTimeout(1200);
  assert.equal(
    qrRequests,
    0,
    "Existing session must not be silently replaced with QR login",
  );
  await page.getByRole("button", { name: "Đóng", exact: true }).click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: recovery status, reconnect control, duplicate-session warning, explicit QR choice and responsive layout at 663x609. Live connection untouched.",
  );
} finally {
  await browser.close();
}
