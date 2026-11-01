import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 820, height: 875 } });
let refreshes = 0;
await page.route("**/api/overview", async (route) => {
  const response = await route.fetch();
  const data = await response.json();
  refreshes++;
  data.zalo.diagnostics = {
    ...data.zalo.diagnostics,
    received: 1000 + refreshes,
  };
  await route.fulfill({ response, json: data });
});
// Force the original gap between shell replacement and contact rendering to be visible.
await page.route("**/api/zalo/contacts", async (route) => {
  await new Promise((r) => setTimeout(r, 600));
  await route.continue();
});
try {
  await page.goto("http://127.0.0.1:3890/#connections");
  await page
    .getByLabel("Mã quản trị")
    .fill((await readFile("data/admin-token", "utf8")).trim());
  await page.getByRole("button", { name: "Đăng nhập dashboard" }).click();
  await page
    .getByRole("heading", { name: "Chẩn đoán nhận tin Zalo" })
    .waitFor();
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    window.__scrollSamples = { initial: scrollY, min: scrollY, max: scrollY };
    window.__scrollTimer = setInterval(() => {
      window.__scrollSamples.min = Math.min(
        window.__scrollSamples.min,
        scrollY,
      );
      window.__scrollSamples.max = Math.max(
        window.__scrollSamples.max,
        scrollY,
      );
    }, 16);
  });
  const firstRefreshes = refreshes;
  await page.waitForTimeout(11500);
  const samples = await page.evaluate(() => {
    clearInterval(window.__scrollTimer);
    return { ...window.__scrollSamples, final: scrollY };
  });
  assert.ok(samples.initial > 200, "Page must be scrolled before checking");
  assert.ok(refreshes >= firstRefreshes + 2, "Live refresh must keep working");
  assert.ok(
    samples.min >= samples.initial - 3,
    `Scroll jumped during refresh: ${JSON.stringify(samples)}`,
  );
  await page
    .getByText(`Đã nhận: ${1000 + refreshes}`, { exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Tổng quan", exact: true }).click();
  await page
    .getByRole("heading", { name: "Mọi kết nối. Một điểm điều phối." })
    .waitFor();
  assert.equal(
    await page.evaluate(() => scrollY),
    0,
    "Intentional navigation starts at top",
  );
  console.log(
    "PASS: bottom scroll preserved across 2 delayed live refreshes at 820x875; fresh status rendered; navigation still starts at top.",
  );
} finally {
  await browser.close();
}
