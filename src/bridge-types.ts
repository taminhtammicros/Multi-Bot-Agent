import { z } from "zod";
import type { RelayEnvelope, RelayPayload } from "./relay-input.js";
export const extraPlatform = z.enum([
  "discord",
  "whatsapp",
  "viber",
  "teams_personal",
]);
export type ExtraPlatform = z.infer<typeof extraPlatform>;
export type Platform = ExtraPlatform | "zalo" | "telegram";
export type NetworkEnvelope = Omit<RelayEnvelope, "platform"> & {
  platform: Platform;
};
export type BinaryMedia = {
  data: Buffer;
  name: string;
  mime: string;
  kind: "image" | "file";
};
export const labels: Record<Platform, string> = {
  zalo: "Zalo",
  telegram: "Tele",
  discord: "Discord",
  whatsapp: "WhatsApp",
  viber: "Viber",
  teams_personal: "Teams",
};
export const networkPayload = z.object({
  sender: z.string().max(100),
  sourceName: z.string().max(100),
  text: z.string().max(16000),
  media: z
    .object({
      kind: z.enum(["image", "file"]),
      name: z.string().max(160),
      bytes: z.number().nonnegative().optional(),
      url: z.string().max(8000).optional(),
      fileId: z.string().max(4096).optional(),
      mime: z.string().max(256).optional(),
    })
    .optional(),
});
export const memberSchema = z
  .object({
    platform: extraPlatform,
    chatId: z.string().trim().min(1).max(2048),
    title: z.string().trim().min(1).max(100),
    receive: z.boolean().default(true),
    send: z.boolean().default(true),
    images: z.boolean().default(true),
    files: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.receive || v.send, {
    message: "Chọn ít nhất một chiều nhận/gửi.",
  });
export const memberPatch = z
  .object({
    enabled: z.boolean().optional(),
    receive: z.boolean().optional(),
    send: z.boolean().optional(),
    images: z.boolean().optional(),
    files: z.boolean().optional(),
    title: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const clean = (v: unknown, max = 16000) =>
  String(v ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")
    .slice(0, max);
export const conflict = (message: string) =>
  Object.assign(new Error(message), { statusCode: 409 });
export function filteredPayload(
  payload: RelayPayload,
  member: { images: boolean; files: boolean },
): RelayPayload | null {
  if (
    !payload.media ||
    (payload.media.kind === "image" ? member.images : member.files)
  )
    return payload;
  return payload.text ? { ...payload, media: undefined } : null;
}
