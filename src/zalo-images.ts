import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const allowedHosts = ["zalo.me", "zadn.vn", "zaloapp.com", "zdn.vn"];
const mimeExt: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const MAX_IMAGE = 6 * 1024 * 1024;
const MAX_TOTAL = 12 * 1024 * 1024;
export type InboundImage = {
  id?: string;
  url?: string;
  data: Buffer;
  mimeType: string;
  path?: string;
};

function strings(value: unknown, output: string[], depth = 0): void {
  if (depth > 5 || output.length > 30) return;
  if (typeof value === "string") {
    output.push(value);
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object")
        strings(parsed, output, depth + 1);
    } catch {}
  } else if (Array.isArray(value)) {
    for (const item of value) strings(item, output, depth + 1);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>))
      strings(item, output, depth + 1);
  }
}

export function zaloImageUrls(message: any): string[] {
  if (message?.msgType !== "chat.photo") return [];
  const candidates: string[] = [];
  strings(message.content, candidates);
  const urls = new Set<string>();
  for (const text of candidates) {
    for (const match of text.match(/https?:\/\/[^\s"'<>\\]+/g) || []) {
      const cleaned = match.replace(/[),.;\]}]+$/, "");
      try {
        const url = new URL(cleaned);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port
        )
          continue;
        const host = url.hostname.toLowerCase();
        if (
          !allowedHosts.some(
            (domain) => host === domain || host.endsWith("." + domain),
          )
        )
          continue;
        urls.add(url.toString());
      } catch {}
    }
  }
  // A single chat.photo payload can contain both href and thumbnail URLs.
  // The first URL is the full photo field in the current Zalo event shape.
  return [...urls].slice(0, 1);
}

export async function fetchZaloImages(urls: string[]): Promise<InboundImage[]> {
  const images: InboundImage[] = [];
  let total = 0;
  for (const url of urls) {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(`Không tải được ảnh Zalo (HTTP ${response.status})`);
    const mimeType =
      response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() || "";
    if (!mimeExt[mimeType])
      throw new Error(
        "Ảnh Zalo có định dạng không hỗ trợ (dùng JPG, PNG, WebP hoặc GIF)",
      );
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_IMAGE) throw new Error("Mỗi ảnh tối đa 6 MB");
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > MAX_IMAGE)
      throw new Error("Ảnh rỗng hoặc vượt giới hạn 6 MB");
    total += data.length;
    if (total > MAX_TOTAL) throw new Error("Tổng dung lượng ảnh vượt 12 MB");
    images.push({ url, data, mimeType });
  }
  return images;
}

export async function storeInboundImages(
  messageId: string,
  images: InboundImage[],
) {
  if (!images.length) return [] as string[];
  const root = resolve("data", "inbound-images");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const paths: string[] = [];
  try {
    for (const image of images) {
      const id = randomUUID();
      const path = join(root, id + mimeExt[image.mimeType]);
      await writeFile(path, image.data, { mode: 0o600, flag: "wx" });
      paths.push(path);
      image.id = id;
      image.path = path;
    }
    return paths;
  } catch (error) {
    await Promise.all(paths.map((path) => rm(path, { force: true })));
    throw error;
  }
}

export async function readInboundImages(messageId: string) {
  const { query } = await import("./db.js");
  const rows = (
    await query(
      "SELECT path,mime_type FROM inbound_images WHERE message_id=$1 ORDER BY id",
      [messageId],
    )
  ).rows;
  const root = resolve("data", "inbound-images") + "/";
  return Promise.all(
    rows.map(async (row) => {
      const path = resolve(row.path);
      if (!path.startsWith(root))
        throw new Error("Đường dẫn ảnh ngoài vùng lưu trữ");
      const data = await readFile(path);
      return { mimeType: String(row.mime_type), data };
    }),
  );
}

export async function removeInboundImages(paths: string[]) {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}
