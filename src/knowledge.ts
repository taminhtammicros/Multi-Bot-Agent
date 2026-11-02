import {
  readFile,
  readdir,
  realpath,
  stat,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { resolve, dirname, extname, relative, basename, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { query } from "./db.js";
const maxFile = 8 * 1024 * 1024;
const supported = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".html",
  ".htm",
  ".pdf",
  ".docx",
  ".log",
  ".yaml",
  ".yml",
]);
const roots = [
  process.cwd(),
  dirname(process.cwd()),
  resolve(homedir(), "Downloads"),
  resolve(homedir(), "Documents"),
  resolve(homedir(), ".hermes/skills"),
  resolve(homedir(), ".codex/skills"),
];
function hiddenSecret(path: string) {
  return (
    path
      .split(/[\\/]/)
      .some((p) => p.startsWith(".") && p !== ".hermes" && p !== ".codex") ||
    /(?:admin-token|encryption-key|zalo-session|auth\.json|credentials|package-lock\.json)$/i.test(
      path,
    )
  );
}
export async function libraryRoots() {
  const found: string[] = [];
  for (const root of roots) {
    try {
      const p = await realpath(root);
      if ((await stat(p)).isDirectory() && !found.includes(p)) found.push(p);
    } catch {}
  }
  return found;
}
export async function safeLocalPath(path: string) {
  const actual = await realpath(resolve(path));
  const allowed = await libraryRoots();
  if (
    !allowed.some((root) => actual === root || actual.startsWith(root + sep)) ||
    hiddenSecret(actual)
  )
    throw Object.assign(
      new Error(
        "Đường dẫn không nằm trong vùng tài liệu cho phép, hoặc là tệp riêng tư.",
      ),
      { statusCode: 400 },
    );
  return actual;
}
export async function browseLibrary(path?: string) {
  const allowed = await libraryRoots();
  const current = await safeLocalPath(path || allowed[0]);
  const entries = (await readdir(current, { withFileTypes: true }))
    .filter(
      (d) =>
        !d.name.startsWith(".") &&
        !["node_modules", "data", "backups", ".git"].includes(d.name) &&
        (d.isDirectory() || supported.has(extname(d.name).toLowerCase())) &&
        !hiddenSecret(d.name),
    )
    .sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 300);
  return {
    roots: allowed,
    path: current,
    parent: allowed.includes(current) ? null : dirname(current),
    entries: entries.map((d) => ({
      name: d.name,
      path: resolve(current, d.name),
      directory: d.isDirectory(),
    })),
  };
}
export async function extractText(buffer: Buffer, name: string) {
  if (buffer.length > maxFile)
    throw Object.assign(new Error("Mỗi file tối đa 8 MB"), { statusCode: 400 });
  const ext = extname(name).toLowerCase();
  if (!supported.has(ext))
    throw Object.assign(
      new Error("Hỗ trợ TXT, MD, CSV, JSON, HTML, PDF, DOCX, YAML"),
      { statusCode: 400 },
    );
  let text = "";
  if (ext === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else if (ext === ".docx") {
    const { extractRawText } = await import("mammoth");
    text = (await extractRawText({ buffer })).value;
  } else if (ext === ".html" || ext === ".htm") {
    const { load } = await import("cheerio");
    const $ = load(buffer.toString("utf8"));
    $("script,style,iframe,object,noscript").remove();
    text = $("main,article").first().text() || $("body").text();
  } else text = buffer.toString("utf8");
  if (text.includes("\0"))
    throw Object.assign(new Error("File không phải văn bản hợp lệ"), {
      statusCode: 400,
    });
  return text.trim().slice(0, 200000);
}
function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const n = address.split(".").map(Number);
    return !(
      n[0] === 0 ||
      n[0] === 10 ||
      n[0] === 127 ||
      n[0] >= 224 ||
      (n[0] === 169 && n[1] === 254) ||
      (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
      (n[0] === 192 && n[1] === 168) ||
      (n[0] === 100 && n[1] >= 64 && n[1] <= 127)
    );
  }
  return (
    isIP(address) === 6 &&
    !/^(::|fc|fd|fe[89ab]|ff)/i.test(address) &&
    !address.includes(":ffff:")
  );
}
export async function webText(raw: string) {
  let url = new URL(raw);
  for (let hop = 0; hop < 4; hop++) {
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !["80", "443"].includes(url.port))
    )
      throw Object.assign(new Error("Chỉ nhận link web HTTP/HTTPS công khai"), {
        statusCode: 400,
      });
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw Object.assign(
        new Error(
          "Không đọc link localhost, mạng nội bộ hoặc địa chỉ metadata",
        ),
        { statusCode: 400 },
      );
    const { Agent } = await import("undici");
    const agent = new Agent({
      connect: {
        lookup: ((_host: any, opts: any, cb: any) =>
          opts.all
            ? cb(null, addresses)
            : cb(null, addresses[0].address, addresses[0].family)) as any,
      },
    });
    try {
      const response = await fetch(url, {
        dispatcher: agent,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      } as any);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Redirect thiếu địa chỉ");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok)
        throw new Error("Trang web trả HTTP " + response.status);
      const type = response.headers.get("content-type") || "";
      if (!/text\/|application\/(json|xml)/i.test(type))
        throw new Error(
          "Link cần trả nội dung văn bản/HTML; file PDF hãy tải lên.",
        );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Trang không có nội dung");
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024)
            throw new Error("Trang vượt giới hạn 4 MB");
          parts.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return {
        text: await extractText(
          Buffer.concat(parts),
          type.includes("html") ? "page.html" : "page.txt",
        ),
        url: url.toString(),
      };
    } finally {
      await agent.close();
    }
  }
  throw new Error("Link chuyển hướng quá nhiều lần");
}
export async function folderText(path: string) {
  const root = await safeLocalPath(path);
  let files = 0,
    total = 0;
  const chunks: string[] = [];
  async function visit(dir: string, depth: number) {
    if (depth > 5) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (files >= 100 || total >= 20 * 1024 * 1024) return;
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "data", "backups", "dist", "build"].includes(
          entry.name,
        )
      )
        continue;
      const p = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(p, depth + 1);
      else if (
        entry.isFile() &&
        supported.has(extname(p).toLowerCase()) &&
        !hiddenSecret(p)
      ) {
        await safeLocalPath(p);
        const info = await stat(p);
        if (info.size > maxFile) continue;
        total += info.size;
        files++;
        chunks.push(
          `TỆP: ${relative(root, p)}\n${await extractText(await readFile(p), p)}`,
        );
      }
    }
  }
  await visit(root, 0);
  return { text: chunks.join("\n\n").slice(0, 500000), files };
}
export async function addSource(
  accountId: string,
  kind: string,
  uid: string,
  input: {
    type: string;
    name?: string;
    locator?: string;
    content?: string;
    buffer?: Buffer;
  },
) {
  const count = (
    await query(
      "SELECT count(*)::int AS n FROM chat_sources WHERE account_id=$1 AND kind=$2 AND uid=$3",
      [accountId, kind, uid],
    )
  ).rows[0].n;
  if (count >= 30)
    throw Object.assign(new Error("Tối đa 30 nguồn mỗi hội thoại"), {
      statusCode: 400,
    });
  const id = randomUUID();
  let content = "",
    locator = input.locator || "",
    name = (input.name || "").slice(0, 200);
  if (input.type === "upload") {
    if (!input.buffer) throw new Error("Thiếu file");
    content = await extractText(input.buffer, name);
    await mkdir("data/library", { recursive: true, mode: 0o700 });
    locator = resolve("data/library", id + extname(name).toLowerCase());
    await writeFile(locator, input.buffer, { mode: 0o600 });
  } else if (input.type === "url") {
    const page = await webText(locator);
    content = page.text;
    locator = page.url;
    name = name || new URL(locator).hostname;
  } else if (input.type === "folder") {
    locator = await safeLocalPath(locator);
    content = (await folderText(locator)).text;
    name = name || basename(locator);
  } else if (input.type === "skill") {
    locator = await safeLocalPath(locator);
    if ((await stat(locator)).isDirectory())
      locator = await safeLocalPath(resolve(locator, "SKILL.md"));
    if (
      basename(locator).toLowerCase() !== "skill.md" &&
      ![".md", ".txt"].includes(extname(locator).toLowerCase())
    )
      throw new Error("Chọn SKILL.md hoặc file hướng dẫn Markdown");
    content = await extractText(await readFile(locator), locator);
    name = name || basename(dirname(locator));
  } else if (input.type === "note") {
    content = (input.content || "").slice(0, 200000);
    name = name || "Ghi chú";
  } else throw new Error("Loại nguồn không hợp lệ");
  if (!content.trim())
    throw Object.assign(new Error("Nguồn không có văn bản đọc được"), {
      statusCode: 400,
    });
  try {
    await query(
      "INSERT INTO chat_sources(id,account_id,kind,uid,source_type,name,locator,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, accountId, kind, uid, input.type, name, locator, content],
    );
  } catch (e) {
    if (input.type === "upload") await rm(locator, { force: true });
    throw e;
  }
  return { id, name, type: input.type, characters: content.length };
}
export async function refreshSource(
  accountId: string,
  kind: string,
  uid: string,
  id: string,
) {
  const row = (
    await query(
      "SELECT * FROM chat_sources WHERE id=$1 AND account_id=$2 AND kind=$3 AND uid=$4",
      [id, accountId, kind, uid],
    )
  ).rows[0];
  if (!row)
    throw Object.assign(new Error("Không tìm thấy nguồn"), { statusCode: 404 });
  let text = row.content;
  if (row.source_type === "url") text = (await webText(row.locator)).text;
  else if (row.source_type === "folder")
    text = (await folderText(row.locator)).text;
  else if (row.source_type === "skill")
    text = await extractText(
      await readFile(await safeLocalPath(row.locator)),
      row.locator,
    );
  else if (row.source_type === "upload")
    text = await extractText(await readFile(row.locator), row.name);
  await query(
    "UPDATE chat_sources SET content=$2,status='ready',error=null,updated_at=now() WHERE id=$1",
    [id, text],
  );
  return { ok: true, characters: text.length };
}
export async function sourceList(accountId: string, kind: string, uid: string) {
  return (
    await query(
      "SELECT id,name,source_type,CASE WHEN source_type='upload' THEN name ELSE locator END AS locator,length(content) AS characters,CASE WHEN source_type='note' THEN content ELSE NULL END AS content,status,error,updated_at FROM chat_sources WHERE account_id=$1 AND kind=$2 AND uid=$3 ORDER BY created_at",
      [accountId, kind, uid],
    )
  ).rows;
}
export async function updateNoteSource(
  accountId: string,
  kind: string,
  uid: string,
  id: string,
  content: string,
) {
  const value = content.trim();
  if (!value)
    throw Object.assign(new Error("Ghi chú không được để trống."), {
      statusCode: 400,
    });
  const updated = await query(
    "UPDATE chat_sources SET content=$5,status='ready',error=null,updated_at=now() WHERE id=$1 AND account_id=$2 AND kind=$3 AND uid=$4 AND source_type='note' RETURNING id,name,length(content)::int AS characters",
    [id, accountId, kind, uid, value],
  );
  if (!updated.rowCount)
    throw Object.assign(new Error("Không tìm thấy ghi chú này."), {
      statusCode: 404,
    });
  return updated.rows[0];
}
export async function removeSource(
  accountId: string,
  kind: string,
  uid: string,
  id: string,
) {
  const rows = (
    await query(
      "DELETE FROM chat_sources WHERE id=$1 AND account_id=$2 AND kind=$3 AND uid=$4 RETURNING source_type,locator",
      [id, accountId, kind, uid],
    )
  ).rows;
  if (rows[0]?.source_type === "upload")
    await rm(rows[0].locator, { force: true });
  return { ok: true };
}
export async function knowledgeContext(
  accountId: string | null,
  kind: string,
  uid: string,
  question: string,
) {
  if (!accountId) return "";
  const rows = (
    await query(
      "SELECT name,source_type,locator,content FROM chat_sources WHERE account_id=$1 AND kind=$2 AND uid=$3 AND status='ready' ORDER BY created_at",
      [accountId, kind, uid],
    )
  ).rows;
  const words = [
    ...new Set(
      question.toLocaleLowerCase("vi").match(/[\p{L}\p{N}]{3,}/gu) || [],
    ),
  ].slice(0, 50);
  const chunks: { text: string; score: number }[] = [];
  for (const row of rows) {
    const label =
      row.source_type === "url"
        ? row.locator
        : `${row.source_type === "skill" ? "SKILL" : "TỆP"}: ${row.name}`;
    for (let i = 0; i < row.content.length; i += 1200) {
      const text = row.content.slice(i, i + 1400);
      const lower = text.toLocaleLowerCase("vi");
      chunks.push({
        text: `[NGUỒN ${label}]\n${text}`,
        score:
          words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0) +
          (row.source_type === "skill" ? 100 : 0),
      });
    }
  }
  return chunks
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
    .map((x) => x.text)
    .join("\n\n")
    .slice(0, 20000);
}
