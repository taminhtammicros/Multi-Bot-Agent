import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  rename,
  rm,
} from "node:fs/promises";
export async function localSecret(name: string, provided?: string) {
  await mkdir("data", { recursive: true, mode: 0o700 });
  if (provided) return provided;
  try {
    return (await readFile(`data/${name}`, "utf8")).trim();
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const secret = randomBytes(32).toString("hex");
  await writeFile(`data/${name}`, secret, { mode: 0o600, flag: "wx" });
  return secret;
}
let key: Buffer;
export async function initSecrets() {
  const value = await localSecret("encryption-key", process.env.ENCRYPTION_KEY);
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error("ENCRYPTION_KEY must contain 64 hexadecimal characters");
  key = Buffer.from(value, "hex");
  return localSecret("admin-token", process.env.ADMIN_TOKEN);
}
export function encrypt(value: string) {
  if (!value) return "";
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([
    iv,
    c.update(value),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}
export function decrypt(value: string) {
  if (!value) return "";
  const b = Buffer.from(value, "base64"),
    d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
}
export function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export async function privateFile(path: string, content: string) {
  const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
