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
let saved,
  sources = [],
  upload = false;
let profile = {
  personality: "",
  brain: "auto",
  model: "",
  provider: "",
  quality: "balanced",
  presentation: "plain",
  emoji: false,
  sequentialReplies: true,
  replyTarget: "none",
  systemCommands: true,
  deniedCommands: "",
  welcome: "",
};
await page.route("**/api/zalo/contacts", (r) =>
  r.fulfill({
    json: {
      accountId: "111",
      groupsEnabled: true,
      contacts: [
        {
          uid: "222",
          kind: "group",
          display_name: "Test group",
          allowed: true,
          mode: "mention",
        },
        {
          uid: "222",
          kind: "dm",
          display_name: "Test DM",
          allowed: true,
          mode: "all",
        },
      ],
    },
  }),
);
await page.route("**/api/chat-profile/**", async (r) => {
  const req = r.request(),
    url = new URL(req.url());
  if (url.pathname.endsWith("/upload")) {
    assert.match(
      req.headers()["content-type"],
      /multipart\/form-data; boundary=/,
    );
    upload = true;
    sources.push({
      id: "file",
      name: "guide.txt",
      source_type: "upload",
      characters: 4,
      locator: "guide.txt",
    });
  } else if (url.pathname.endsWith("/sources")) {
    const s = req.postDataJSON().source;
    sources.push({
      id: String(sources.length),
      name: s.type,
      source_type: s.type,
      characters: 10,
      locator: s.locator || "",
    });
  } else if (req.method() === "PUT") {
    saved = req.postDataJSON();
    profile = saved.profile;
  }
  await r.fulfill({ json: { profile, sources, guard: { ready: true } } });
});
await page.route("**/api/agents/hermes/catalog", (r) =>
  r.fulfill({
    json: {
      models: [{ id: "test-model", provider: "custom", label: "Test model" }],
    },
  }),
);
await page.route("**/api/library/browse*", (r) =>
  r.fulfill({
    json: {
      roots: ["/test/docs"],
      path: "/test/docs",
      parent: null,
      entries: [
        { name: "SKILL.md", path: "/test/docs/SKILL.md", directory: false },
      ],
    },
  }),
);
try {
  await page.goto("http://127.0.0.1:3890/#connections");
  await page
    .getByLabel("Mã quản trị")
    .fill((await readFile("data/admin-token", "utf8")).trim());
  await page.getByRole("button", { name: "Đăng nhập dashboard" }).click();
  await page.locator('[data-chat-settings][data-chat-kind="group"]').click();
  const dialog = page.locator("dialog[open]");
  await dialog.locator('[data-profile-tab="conversation"]').click();
  assert.ok(await dialog.locator('[name="sequentialReplies"]').isChecked());
  await dialog.locator('[name="sequentialReplies"]').uncheck();
  await dialog.locator('[name="replyTarget"]').selectOption("both");
  await dialog.locator('[data-profile-tab="persona"]').click();
  await dialog
    .locator('[name="personality"]')
    .fill("Xưng em, gọi mọi người là anh chị.");
  assert.equal(
    await dialog.locator('[name="personality"]').getAttribute("maxlength"),
    "2000",
  );
  await dialog.locator('[data-profile-tab="knowledge"]').click();
  await dialog.locator("#profile-file").setInputFiles({
    name: "guide.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("test"),
  });
  await page.waitForFunction(() =>
    document
      .querySelector("#profile-sources")
      ?.textContent.includes("guide.txt"),
  );
  assert.ok(upload);
  await dialog.locator("#profile-note").fill("Quy định nội bộ");
  await dialog.locator("#profile-add-note").click();
  await dialog.locator('[data-browse-source="folder"]').click();
  await dialog.locator("[data-use-folder]").click();
  await dialog.locator('[data-browse-source="skill"]').click();
  await dialog.locator("[data-library-path]").click();
  await page.waitForFunction(() =>
    document.querySelector("#profile-sources")?.textContent.includes("skill"),
  );
  assert.deepEqual(
    sources.map((s) => s.source_type),
    ["upload", "note", "folder", "skill"],
  );
  await dialog.locator('[data-profile-tab="connection"]').click();
  await dialog.locator('[name="brain"]').selectOption("hermes");
  await dialog.locator('[name="handoffSynthesis"]').selectOption("verify");
  await dialog.locator('[name="openClawSupport"]').uncheck();
  await dialog.locator("#profile-load-models").click();
  await dialog.locator("#profile-model-picker").selectOption("0");
  await dialog.locator('[name="quality"][value="long"]').check();
  await dialog.locator('[data-profile-tab="style"]').click();
  await dialog.locator('[name="presentation"][value="color"]').check();
  await dialog.locator('[name="emoji"]').check();
  await dialog.locator('[data-profile-tab="policy"]').click();
  await dialog.locator('[name="systemCommands"]').uncheck();
  await dialog.locator('[name="deniedCommands"]').fill("rm -rf\nsudo");
  await dialog.locator('[name="welcome"]').fill("Chào {members}, đến {group}!");
  await dialog.getByRole("button", { name: "Lưu cấu hình hội thoại" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#profile-save-state")
      ?.textContent.startsWith("Đã lưu"),
  );
  assert.equal(saved.accountId, "111");
  assert.equal(saved.profile.brain, "hermes");
  assert.equal(saved.profile.handoffSynthesis, "verify");
  assert.equal(saved.profile.openClawSupport, false);
  assert.equal(saved.profile.sequentialReplies, false);
  assert.equal(saved.profile.replyTarget, "both");
  assert.equal(saved.profile.model, "test-model");
  assert.equal(saved.profile.provider, "custom");
  assert.equal(saved.profile.systemCommands, false);
  assert.equal(saved.profile.quality, "long");
  assert.equal(saved.profile.emoji, true);
  await page.setViewportSize({ width: 663, height: 609 });
  assert.ok(
    await dialog
      .getByRole("button", { name: "Lưu cấu hình hội thoại" })
      .isVisible(),
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await dialog.locator("[data-profile-close]").click();
  await page.locator('[data-chat-settings][data-chat-kind="dm"]').click();
  await dialog.locator('[data-profile-tab="policy"]').click();
  assert.equal(await dialog.locator('[name="welcome"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Chat profile UI: scoped row settings, upload, folder/skill browse, model, quality, style, policy, welcome and mobile passed.",
  );
} finally {
  await browser.close();
}
