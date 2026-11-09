// This function is serialized into the signed-in browser. It reads rendered UI only.
export function teamsDomSnapshot() {
  const doc = document;
  const profile = doc.querySelector<HTMLElement>(
    '[data-tid="me-control-avatar-trigger"]',
  );
  const profileLabel = profile?.getAttribute("aria-label") || "";
  const accountId =
    profileLabel
      .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
      ?.toLowerCase() || "";
  const selfName = (profile?.innerText || "").split("\n")[0].trim();
  const titles = [
    ...doc.querySelectorAll<HTMLElement>(
      '[data-tid="chat-title"], [data-tid="chat-header-title"]',
    ),
  ];
  const title = titles.length === 1 ? titles[0].innerText.trim() : "";
  const selected = [
    ...doc.querySelectorAll<HTMLElement>(
      '[role="treeitem"][data-item-type="chat"], [role="treeitem"][data-item-type="muted-chat"]',
    ),
  ].filter((el) => {
    try {
      return JSON.parse(
        el.getAttribute("data-tabster") || "{}",
      ).observed?.names?.includes("LeftRailSelectedItem");
    } catch {
      return false;
    }
  });
  let chatId = "";
  if (selected.length === 1) {
    const label = selected[0].querySelector<HTMLElement>(
      '[id^="title-chat-list-item_"]',
    );
    chatId = label?.id.slice("title-chat-list-item_".length) || "";
  }
  if (!chatId) chatId = new URL(location.href).searchParams.get("chatId") || "";
  const rows: {
    id: string;
    author: string;
    text: string;
    at: number;
    media: boolean;
  }[] = [];
  const seen = new Set<string>();
  for (const root of [
    ...doc.querySelectorAll<HTMLElement>(
      '[data-message-id], [data-tid="chat-pane-message"]',
    ),
  ].slice(-200)) {
    const id =
      root.getAttribute("data-message-id") ||
      root.getAttribute("data-mid") ||
      root.id.match(/(?:message-body-)?(\d{13,})/)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const refs = (root.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter(Boolean) as HTMLElement[];
    const author =
      doc.getElementById("author-" + id) ||
      refs.find((x) => x.getAttribute("data-tid") === "message-author-name") ||
      root.querySelector<HTMLElement>(
        '[data-tid="message-author-name"], [data-tid="threadBodyDisplayName"], [data-tid="message-author"]',
      );
    const body =
      doc.getElementById("content-" + id) ||
      root.querySelector<HTMLElement>(
        '[data-tid="message-body"], [data-tid="chat-pane-message-content"]',
      );
    const time =
      doc.getElementById("timestamp-" + id) ||
      root.querySelector("time[datetime]");
    const iso = time?.getAttribute("datetime");
    const at = iso ? Date.parse(iso) : /^\d{13}$/.test(id) ? Number(id) : NaN;
    const attachments = doc.getElementById("attachments-" + id);
    const media = Boolean(
      attachments?.childElementCount ||
      root.querySelector(
        '[data-tid*="attachment"], [data-tid*="image-renderer"], [data-tid*="file-card"]',
      ),
    );
    rows.push({
      id,
      author: author?.textContent?.trim() || "",
      text: (body?.innerText || "").trim().slice(0, 16000),
      at,
      media,
    });
  }
  const editors = [
    ...doc.querySelectorAll<HTMLElement>(
      '[contenteditable="true"][role="textbox"], .ck-editor__editable[contenteditable="true"]',
    ),
  ].filter((x) => x.getClientRects().length);
  const sends = [
    ...doc.querySelectorAll<HTMLButtonElement>(
      '[data-tid="sendMessageCommands-send"], [data-tid="newMessageCommands-send"]',
    ),
  ].filter((x) => x.getClientRects().length);
  return {
    accountId,
    selfName,
    title,
    chatId,
    rows,
    composerReady: editors.length === 1,
    draftLength: editors.length === 1 ? editors[0].innerText.trim().length : -1,
    sendReady: sends.length === 1 && !sends[0].disabled,
  };
}
