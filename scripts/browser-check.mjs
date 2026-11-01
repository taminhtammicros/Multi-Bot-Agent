import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://127.0.0.1:3890");
  await page
    .getByLabel("Mã quản trị")
    .fill((await readFile("data/admin-token", "utf8")).trim());
  await page.getByRole("button", { name: "Đăng nhập dashboard" }).click();
  await page
    .getByRole("heading", { name: "Mọi kết nối. Một điểm điều phối." })
    .waitFor();
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Kết nối", exact: true }).click();
  await page
    .getByRole("heading", { name: "Kết nối không gian làm việc" })
    .waitFor();
  await page
    .getByRole("button", { name: "Cấu hình", exact: true })
    .first()
    .click();
  await page.getByRole("heading", { name: "Kết nối Hermes" }).waitFor();
  await page.getByRole("button", { name: "Hủy", exact: true }).click();
  await page
    .getByRole("button", { name: "Cài đặt nhóm & UID", exact: true })
    .click();
  await page.getByRole("heading", { name: "Quyền truy cập Zalo" }).waitFor();
  await page.getByRole("button", { name: "Hủy", exact: true }).click();
  await page.getByRole("link", { name: "Hội thoại", exact: true }).click();
  await page.getByRole("heading", { name: "Hội thoại & ngữ cảnh" }).waitFor();
  await page.getByRole("link", { name: "Công việc", exact: true }).click();
  await page.getByRole("heading", { name: "Công việc & nhiệm vụ" }).waitFor();
  await page.getByRole("link", { name: "Bộ nhớ chung", exact: true }).click();
  await page
    .getByRole("heading", { name: "Bộ nhớ chung", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Main & BCP", exact: true }).click();
  await page
    .getByRole("heading", { name: "Duy trì hoạt động, giữ đúng ngữ cảnh" })
    .waitFor();
  await page
    .getByRole("link", { name: "Nhật ký hệ thống", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Nhật ký hệ thống", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Tổng quan", exact: true }).click();
  await page
    .getByRole("heading", { name: "Mọi kết nối. Một điểm điều phối." })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Mobile has horizontal overflow",
  );
  assert.deepEqual(errors, []);
  await page.getByRole("link", { name: "Kết nối", exact: true }).click();
  await page
    .getByRole("heading", { name: "Kết nối không gian làm việc" })
    .waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  const unauth = await browser.newContext();
  const protectedResponse = await unauth.request.get(
    "http://127.0.0.1:3890/api/overview",
  );
  assert.equal(protectedResponse.status(), 401);
  const crossOrigin = await page.request.put(
    "http://127.0.0.1:3890/api/routing",
    { headers: { Origin: "http://untrusted.invalid" }, data: {} },
  );
  assert.equal(crossOrigin.status(), 403);
  await unauth.close();
  console.log(
    "Browser PASS: login, 7 pages, connection forms, mobile layout, auth and origin guard. Screenshots in test-results/.",
  );
} finally {
  await browser.close();
}
