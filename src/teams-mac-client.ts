import { z } from "zod";
import { RelayDeliveryError } from "./channel-relay.js";
export type TeamsMacConfig = {
  transport?: string;
  workerToken?: string;
  selfName?: string;
};
export const teamsMacState = z.object({
  accountId: z.string().email(),
  selfName: z.string().min(1).max(100),
  open: z.boolean().optional(),
  mode: z.literal("coccoc_mac").optional(),
  title: z.string().max(100),
  chatId: z.string().max(2048),
});
export const teamsMacMessages = teamsMacState.extend({
  rows: z
    .array(
      z.object({
        id: z.string().regex(/^\d{13,20}$/),
        author: z.string().max(100),
        text: z.string().max(16000),
        at: z.number().finite(),
        media: z.boolean(),
      }),
    )
    .max(200),
  composerReady: z.boolean(),
  draftLength: z.number().int(),
  sendReady: z.boolean(),
});
export async function callTeamsMac(
  config: TeamsMacConfig,
  path: "/state" | "/bind" | "/messages" | "/send",
  body: unknown = {},
  request: typeof fetch = fetch,
) {
  if (!/^[a-f0-9]{64}$/.test(config.workerToken || ""))
    throw new RelayDeliveryError(
      "Chưa có khóa kết nối Cốc Cốc trên Mac.",
      false,
    );
  let response: Response;
  try {
    response = await request("http://127.0.0.1:13994" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + config.workerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(path === "/send" ? 45000 : 18000),
    });
  } catch {
    throw new RelayDeliveryError(
      path === "/send"
        ? "Không nhận được xác nhận gửi từ Cốc Cốc; cần đối soát."
        : "Không kết nối được Cốc Cốc trên Mac. Kiểm tra máy Mac và đường hầm SSH.",
      path === "/send",
    );
  }
  let result: any;
  try {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error();
    result = JSON.parse(raw);
  } catch {
    throw new RelayDeliveryError(
      "Cốc Cốc trả phản hồi chưa xác nhận được.",
      path === "/send",
    );
  }
  if (!response.ok)
    throw new RelayDeliveryError(
      String(result.error || "Cốc Cốc chưa sẵn sàng.").slice(0, 220),
      path === "/send" &&
        (result.ambiguous === true || typeof result.ambiguous !== "boolean"),
      response.status === 429
        ? Math.min(Math.max(Number(result.retry_after) || 5, 5), 3600)
        : undefined,
    );
  return result;
}
