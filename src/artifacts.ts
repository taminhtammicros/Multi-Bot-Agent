import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { query } from "./db.js";

const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 12 * 1024 * 1024;
const mimeByExt: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export type AgentArtifact = {
  filename: string;
  mimeType: string;
  dataBase64: string;
};
export type StoredArtifact = {
  id: string;
  filename: string;
  mimeType: string;
  path: string;
  size: number;
};

// Agents can return either message.artifacts or this explicit content envelope:
// [[ZALO_ARTIFACTS_V1]]{"text":"...","artifacts":[{"filename":"report.txt","mimeType":"text/plain","dataBase64":"..."}]}
export function extractArtifacts(content: string, attached?: unknown) {
  let text = content;
  let artifacts: any = Array.isArray(attached) ? attached : [];
  const marker = "[[ZALO_ARTIFACTS_V1]]";
  const index = content.indexOf(marker);
  if (index >= 0) {
    const envelope = JSON.parse(content.slice(index + marker.length));
    if (typeof envelope.text !== "string" || !Array.isArray(envelope.artifacts))
      throw new Error("Agent trả artifact envelope sai cấu trúc");
    text = (content.slice(0, index) + envelope.text).trim();
    artifacts = [...artifacts, ...envelope.artifacts];
  }
  return { text, artifacts: artifacts as AgentArtifact[] };
}

export async function storeArtifacts(taskId: string, raw: AgentArtifact[]) {
  if (!raw.length) return [] as StoredArtifact[];
  if (raw.length > 5) throw new Error("Mỗi câu trả lời tối đa 5 tệp");
  const root = resolve("data", "artifacts");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const result: StoredArtifact[] = [];
  let total = 0;
  try {
    for (const item of raw) {
      if (
        !item ||
        typeof item.filename !== "string" ||
        typeof item.mimeType !== "string" ||
        typeof item.dataBase64 !== "string"
      )
        throw new Error("Agent trả metadata tệp không hợp lệ");
      const filename = item.filename
        .split(/[\\/]/)
        .at(-1)!
        .replace(/[^\p{L}\p{N}._ -]/gu, "_")
        .slice(0, 120);
      const ext = extname(filename).toLowerCase();
      if (!filename || !mimeByExt[ext] || mimeByExt[ext] !== item.mimeType)
        throw new Error(`Định dạng hoặc MIME chưa hỗ trợ: ${filename}`);
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          item.dataBase64,
        )
      )
        throw new Error(`Dữ liệu Base64 không hợp lệ: ${filename}`);
      const data = Buffer.from(item.dataBase64, "base64");
      if (
        !data.length ||
        data.length > MAX_FILE ||
        data.toString("base64") !== item.dataBase64
      )
        throw new Error(`Tệp rỗng, sai mã hóa hoặc vượt 8 MB: ${filename}`);
      if (
        [".docx", ".xlsx", ".pptx"].includes(ext) &&
        (data.length < 4 || data.subarray(0, 4).toString("hex") !== "504b0304")
      )
        throw new Error(
          `Tệp Office không có cấu trúc Open XML hợp lệ: ${filename}`,
        );
      total += data.length;
      if (total > MAX_TOTAL)
        throw new Error("Tổng dung lượng đính kèm vượt 12 MB");
      const id = randomUUID();
      const path = join(root, id + ext);
      await writeFile(path, data, { mode: 0o600, flag: "wx" });
      result.push({
        id,
        filename,
        mimeType: item.mimeType,
        path,
        size: data.length,
      });
    }
    for (const artifact of result)
      await query(
        "INSERT INTO artifacts(id,task_id,filename,mime_type,path,size) VALUES($1,$2,$3,$4,$5,$6)",
        [
          artifact.id,
          taskId,
          artifact.filename,
          artifact.mimeType,
          artifact.path,
          artifact.size,
        ],
      );
    return result;
  } catch (error) {
    await Promise.all(result.map((a) => rm(a.path, { force: true })));
    if (result.length)
      await query("DELETE FROM artifacts WHERE id=ANY($1::uuid[])", [
        result.map((a) => a.id),
      ]).catch(() => {});
    throw error;
  }
}

export async function readArtifact(id: string) {
  const row = (
    await query(
      "SELECT filename,mime_type,path,size FROM artifacts WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!row) return null;
  const root = resolve("data", "artifacts") + "/";
  if (!resolve(row.path).startsWith(root))
    throw new Error("Artifact path ngoài vùng lưu trữ");
  return { ...row, data: await readFile(row.path) };
}
