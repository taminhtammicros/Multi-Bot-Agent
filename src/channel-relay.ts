import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import { query, pool, setting, event } from "./db.js";
import { encrypt, decrypt } from "./security.js";
import { getZaloPolicy } from "./zalo-policy.js";
import { replyMode } from "./reply-policy.js";
import {
  downloadRelayFile,
  RELAY_MAX_BYTES,
  safeRelayFilename,
} from "./relay-media.js";
import {
  relayTextChunks,
  type RelayEnvelope,
  type RelayPayload,
} from "./relay-input.js";
const direction = z.enum(["both", "zalo_to_telegram", "telegram_to_zalo"]);
export const createRelaySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    zaloGroupId: z.string().regex(/^\d{1,30}$/),
    telegramChatId: z.string().regex(/^-\d{1,20}$/),
    direction: direction.default("both"),
    media: z.boolean().default(true),
  })
  .strict();
export const updateRelaySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    direction: direction.optional(),
    media: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
const payloadSchema = z.object({
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
export type RelayGroupCheck = {
  botId: string;
  chatId: string;
  title: string;
  member: boolean;
  canReadAll: boolean;
  canSend: boolean;
  canSendMedia: boolean;
};
export type RelayRuntime = {
  zaloAccountId: string | null;
  zaloConnected: boolean;
  telegramBotId: string | null;
  telegramReceiving?: boolean;
};
export type RelayPorts = {
  runtime: () => Promise<RelayRuntime>;
  checkTelegram: (chatId: string) => Promise<RelayGroupCheck>;
  telegramFile: (
    fileId: string,
  ) => Promise<{ data: Buffer; name: string; mime: string }>;
  sendZalo: (chatId: string, text: string, path?: string) => Promise<string>;
  sendTelegram: (
    chatId: string,
    text: string,
    media?: {
      data: Buffer;
      name: string;
      mime: string;
      kind: "image" | "file";
    },
  ) => Promise<string>;
};
export class RelayDeliveryError extends Error {
  constructor(
    message: string,
    readonly ambiguous = true,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}
class RelayRevoked extends Error {}
const httpError = (message: string) =>
  Object.assign(new Error(message), { statusCode: 409 });
const accepts = (b: any, source: string) =>
  b.direction === "both" ||
  b.direction === (source === "zalo" ? "zalo_to_telegram" : "telegram_to_zalo");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export class ChannelRelay {
  private busy = false;
  constructor(
    private readonly ports: RelayPorts,
    private readonly pause = sleep,
    private readonly download = downloadRelayFile,
  ) {}
  async view() {
    const state = await this.ports.runtime();
    return {
      runtime: state,
      bridges: (
        await query(
          `SELECT b.*,z.display_name AS zalo_name,t.title AS telegram_name,(SELECT count(*)::int FROM channel_bridge_outbox o WHERE o.bridge_id=b.id AND status IN ('queued','preparing','sending')) AS pending,(SELECT count(*)::int FROM channel_bridge_outbox o WHERE o.bridge_id=b.id AND status='sent') AS sent,(SELECT count(*)::int FROM channel_bridge_outbox o WHERE o.bridge_id=b.id AND status IN ('review','failed')) AS attention FROM channel_bridges b LEFT JOIN zalo_groups z ON z.account_id=b.zalo_account_id AND z.group_id=b.zalo_group_id LEFT JOIN telegram_relay_groups t ON t.bot_id=b.telegram_bot_id AND t.chat_id=b.telegram_chat_id WHERE b.archived_at IS NULL ORDER BY b.created_at DESC`,
        )
      ).rows,
      zaloGroups: (
        await query(
          "SELECT group_id,display_name FROM zalo_groups WHERE account_id=$1 ORDER BY display_name",
          [state.zaloAccountId],
        )
      ).rows,
      telegramGroups: (
        await query(
          "SELECT * FROM telegram_relay_groups WHERE bot_id=$1 ORDER BY last_seen DESC",
          [state.telegramBotId],
        )
      ).rows,
    };
  }
  async create(raw: unknown) {
    const input = createRelaySchema.parse(raw),
      state = await this.ports.runtime();
    if (!state.zaloAccountId || !state.telegramBotId)
      throw httpError("Cần kết nối cả tài khoản Zalo và bot Telegram trước.");
    if (
      !(
        await query(
          "SELECT 1 FROM zalo_groups WHERE account_id=$1 AND group_id=$2",
          [state.zaloAccountId, input.zaloGroupId],
        )
      ).rowCount
    )
      throw httpError(
        "Nhóm Zalo chưa được nhận diện trên tài khoản đang kết nối.",
      );
    const tg = await this.ports.checkTelegram(input.telegramChatId);
    if (
      tg.botId !== state.telegramBotId ||
      tg.chatId !== input.telegramChatId ||
      !tg.member
    )
      throw httpError("Bot Telegram chưa tham gia nhóm này.");
    const id = randomUUID();
    try {
      await query(
        "INSERT INTO channel_bridges(id,name,zalo_account_id,zalo_group_id,telegram_bot_id,telegram_chat_id,direction,media) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          input.name,
          state.zaloAccountId,
          input.zaloGroupId,
          state.telegramBotId,
          input.telegramChatId,
          input.direction,
          input.media,
        ],
      );
    } catch (e: any) {
      if (e.code === "23505")
        throw httpError(
          "Một trong hai nhóm đã có cầu nối. Anh sửa hoặc xóa cầu nối cũ trước.",
        );
      throw e;
    }
    await event("channel_bridge", "Tạo cầu nối tạm dừng " + id);
    return { id, enabled: false };
  }
  private async authorized(b: any, source?: string) {
    if (!b || !b.enabled || b.archived_at || (source && !accepts(b, source)))
      return false;
    const state = await this.ports.runtime();
    if (
      state.zaloAccountId !== b.zalo_account_id ||
      state.telegramBotId !== b.telegram_bot_id
    )
      return false;
    const policy = await getZaloPolicy(b.zalo_account_id);
    return (
      policy.groupsEnabled &&
      policy.allowGroups.includes(b.zalo_group_id) &&
      (await replyMode(b.zalo_account_id, "group", b.zalo_group_id, policy)) !==
        "silent"
    );
  }
  async verify(b: any) {
    if (!b) throw httpError("Không tìm thấy cầu nối.");
    if (!(await this.authorized({ ...b, enabled: true })))
      throw httpError(
        "Tài khoản/bot không khớp, hoặc nhóm Zalo chưa được cho phép. Bật quyền nhóm và chọn chế độ Khi được tag hoặc Luôn trả lời trước.",
      );
    if (
      b.direction !== "zalo_to_telegram" &&
      (await this.ports.runtime()).telegramReceiving === false
    )
      throw httpError(
        "Luồng nhận Telegram tại Hub chưa ổn định. Anh kiểm tra trạng thái Telegram trên trang Kênh rồi bật cầu nối sau khi kết nối sẵn sàng.",
      );
    const tg = await this.ports.checkTelegram(b.telegram_chat_id);
    if (
      tg.botId !== b.telegram_bot_id ||
      tg.chatId !== b.telegram_chat_id ||
      !tg.member
    )
      throw httpError("Bot Telegram chưa ở trong nhóm.");
    if (b.direction !== "zalo_to_telegram" && !tg.canReadAll)
      throw httpError(
        "Để nhận mọi tin Telegram, đặt bot làm quản trị viên nhóm hoặc tắt Group Privacy trong BotFather, rồi kiểm tra lại.",
      );
    if (
      b.direction !== "telegram_to_zalo" &&
      (!tg.canSend || (b.media && !tg.canSendMedia))
    )
      throw httpError(
        "Bot Telegram chưa có quyền gửi văn bản/ảnh/file cần thiết.",
      );
    return tg;
  }
  async update(id: string, raw: unknown) {
    const patch = updateRelaySchema.parse(raw),
      db = await pool.connect();
    try {
      await db.query("BEGIN");
      const b = (
        await db.query(
          "SELECT * FROM channel_bridges WHERE id=$1 AND archived_at IS NULL FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!b) throw httpError("Cầu nối không còn tồn tại.");
      const next = { ...b, ...patch };
      if (next.enabled) await this.verify(next);
      const reset =
        next.enabled &&
        (!b.enabled ||
          next.direction !== b.direction ||
          next.media !== b.media);
      await db.query(
        "UPDATE channel_bridges SET name=$2,direction=$3,media=$4,enabled=$5,activated_at=CASE WHEN $6 THEN now() ELSE activated_at END,updated_at=now() WHERE id=$1",
        [id, next.name, next.direction, next.media, next.enabled, reset],
      );
      if (!next.enabled || reset)
        await db.query(
          "UPDATE channel_bridge_outbox SET status='cancelled',error='Cấu hình cầu nối đã thay đổi.',finished_at=now() WHERE bridge_id=$1 AND status IN ('queued','preparing')",
          [id],
        );
      if (!next.enabled || reset) await db.query("UPDATE bridge_deliveries SET status='cancelled',error='Cấu hình phòng Bridge đã đổi.',finished_at=now() WHERE bridge_id=$1 AND status IN ('queued','preparing')",[id]);
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    await event("channel_bridge", "Cập nhật cầu nối " + id);
    return { ok: true };
  }
  async remove(id: string) {
    await query(
      "UPDATE channel_bridges SET enabled=false,archived_at=now(),updated_at=now() WHERE id=$1",
      [id],
    );
    await query(
      "UPDATE channel_bridge_outbox SET status='cancelled',error='Cầu nối đã xóa.',finished_at=now() WHERE bridge_id=$1 AND status IN ('queued','preparing')",
      [id],
    );
    await query("UPDATE bridge_deliveries SET status='cancelled',error='Phòng đã xóa.',finished_at=now() WHERE bridge_id=$1 AND status IN ('queued','preparing')",[id]);
    return { ok: true };
  }
  async history(id: string) {
    return (
      await query(
        "SELECT id,source_platform,kind,status,attempts,error,receipts,created_at,finished_at FROM channel_bridge_outbox WHERE bridge_id=$1 ORDER BY seq DESC LIMIT 50",
        [id],
      )
    ).rows;
  }
  async enqueue(input: RelayEnvelope) {
    if (!input.messageId || !Number.isFinite(input.at.getTime())) return 0;
    const rows = (
      await query(
        `SELECT * FROM channel_bridges WHERE enabled AND archived_at IS NULL AND ${input.platform === "zalo" ? "zalo_account_id=$1 AND zalo_group_id=$2" : "telegram_bot_id=$1 AND telegram_chat_id=$2"}`,
        [input.accountId, input.chatId],
      )
    ).rows;
    let count = 0;
    for (const b of rows) {
      if (
        !(await this.authorized(b, input.platform)) ||
        !b.activated_at ||
        input.at.getTime() <
          Math.floor(new Date(b.activated_at).getTime() / 1000) * 1000
      )
        continue;
      let payload = payloadSchema.parse(input.payload);
      if (payload.media && !b.media) {
        if (!payload.text) continue;
        payload = { ...payload, media: undefined };
      }
      const oversize = Boolean(
        payload.media?.bytes && payload.media.bytes > RELAY_MAX_BYTES,
      );
      const r = await query(
        "INSERT INTO channel_bridge_outbox(id,bridge_id,source_platform,source_account_id,source_chat_id,source_message_id,source_at,activation_at,kind,payload_cipher,status,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          b.id,
          input.platform,
          input.accountId,
          input.chatId,
          input.messageId,
          input.at,
          b.activated_at,
          payload.media?.kind || "text",
          encrypt(JSON.stringify(payload)),
          oversize ? "failed" : "queued",
          oversize ? "File vượt giới hạn Bridge 20 MB." : null,
        ],
      );
      count += r.rowCount || 0;
    }
    return count;
  }
  async recover() {
    await query(
      "UPDATE channel_bridge_outbox SET status='review',error='Dịch vụ khởi động lại sau khi bắt đầu gửi; cần đối soát, không tự gửi lại.',finished_at=now() WHERE status='sending'",
    );
    await query(
      "UPDATE channel_bridge_outbox SET status='queued',claimed_at=null WHERE status='preparing'",
    );
    const root = resolve("data/bridge-tmp");
    for (const entry of await readdir(root, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (entry.isDirectory() && /^relay-[a-zA-Z0-9-]+$/.test(entry.name))
        await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
  async flush() {
    if (this.busy) return;
    this.busy = true;
    let job: any,
      attempted = false,
      receipts: string[] = [],
      temp: string | undefined;
    try {
      if ((await setting<any>("routing"))?.paused) return;
      job = (
        await query(
          `WITH picked AS (SELECT o.id FROM channel_bridge_outbox o JOIN channel_bridges b ON b.id=o.bridge_id WHERE o.status='queued' AND o.next_attempt_at<=now() AND b.enabled AND b.archived_at IS NULL AND b.next_send_at<=now() AND NOT EXISTS(SELECT 1 FROM channel_bridge_outbox older WHERE older.bridge_id=o.bridge_id AND older.seq<o.seq AND older.status IN ('queued','preparing','sending')) ORDER BY o.seq LIMIT 1 FOR UPDATE OF o SKIP LOCKED) UPDATE channel_bridge_outbox o SET status='preparing',attempts=attempts+1,claimed_at=now() FROM picked WHERE o.id=picked.id RETURNING o.*`,
        )
      ).rows[0];
      if (!job) return;
      const payload = payloadSchema.parse(
        JSON.parse(decrypt(job.payload_cipher)),
      ) as RelayPayload;
      const gate = async (checkRemote = false) => {
        const b = (
          await query("SELECT * FROM channel_bridges WHERE id=$1", [
            job.bridge_id,
          ])
        ).rows[0];
        const status = (
          await query("SELECT status FROM channel_bridge_outbox WHERE id=$1", [
            job.id,
          ])
        ).rows[0]?.status;
        if (
          !["preparing", "sending"].includes(status) ||
          !(await this.authorized(b, job.source_platform)) ||
          new Date(b.activated_at).getTime() !==
            new Date(job.activation_at).getTime() ||
          (payload.media && !b.media)
        )
          throw new RelayRevoked();
        if (checkRemote) await this.verify(b);
        return b;
      };
      const runtime = await this.ports.runtime();
      if (
        !runtime.zaloConnected ||
        !runtime.telegramBotId ||
        runtime.telegramReceiving === false
      ) {
        await query(
          "UPDATE channel_bridge_outbox SET status='queued',attempts=attempts-1,next_attempt_at=now()+interval '5 seconds' WHERE id=$1 AND status='preparing'",
          [job.id],
        );
        return;
      }
      const b = await gate(true);
      let media:
          | { data: Buffer; name: string; mime: string; kind: "image" | "file" }
          | undefined,
        path: string | undefined;
      if (payload.media) {
        const item = payload.media;
        let loaded: { data: Buffer; name?: string; mime: string };
        if (job.source_platform === "telegram") {
          if (!item.fileId) throw new Error("Thiếu ID file Telegram.");
          loaded = await this.ports.telegramFile(item.fileId);
        } else {
          if (!item.url) throw new Error("Thiếu link file Zalo.");
          loaded = await this.download(item.url);
        }
        if (loaded.data.length > RELAY_MAX_BYTES)
          throw new Error("File vượt giới hạn Bridge 20 MB.");
        media = {
          data: loaded.data,
          name: safeRelayFilename(item.name || loaded.name || "attachment.bin"),
          mime: item.mime || loaded.mime,
          kind: item.kind,
        };
        if (job.source_platform === "telegram") {
          const root = resolve("data/bridge-tmp");
          await mkdir(root, { recursive: true, mode: 0o700 });
          temp = await mkdtemp(join(root, "relay-"));
          path = join(temp, media.name);
          await writeFile(path, media.data, { mode: 0o600 });
        }
      }
      const label = job.source_platform === "zalo" ? "Zalo" : "Tele",
        prefix = `[${label}]\n${payload.sender}:`;
      const parts = media
        ? [prefix, ...relayTextChunks(payload.text)]
        : relayTextChunks(prefix + "\n" + payload.text);
      for (let i = 0; i < parts.length; i++) {
        if (i) await this.pause(3100);
        await gate(true);
        const claimed = await query(
          "UPDATE channel_bridge_outbox SET status='sending' WHERE id=$1 AND status IN ('preparing','sending')",
          [job.id],
        );
        if (!claimed.rowCount) throw new RelayRevoked();
        attempted = true;
        const receipt =
          job.source_platform === "zalo"
            ? await this.ports.sendTelegram(
                b.telegram_chat_id,
                parts[i],
                i === 0 ? media : undefined,
              )
            : await this.ports.sendZalo(
                b.zalo_group_id,
                parts[i],
                i === 0 ? path : undefined,
              );
        if (!receipt)
          throw new RelayDeliveryError(
            "Kênh đích chưa xác nhận ID tin nhắn.",
            true,
          );
        receipts.push(receipt);
        await query(
          "UPDATE channel_bridge_outbox SET receipts=$2::jsonb WHERE id=$1",
          [job.id, JSON.stringify(receipts)],
        );
      }
      await query(
        "UPDATE channel_bridge_outbox SET status='sent',error=null,finished_at=now() WHERE id=$1 AND status='sending'",
        [job.id],
      );
      await query(
        "UPDATE channel_bridges SET next_send_at=now()+interval '3.1 seconds' WHERE id=$1",
        [job.bridge_id],
      );
    } catch (error) {
      if (job) {
        const e = error as any;
        const message = String(e?.message || "Không chuyển được tin.")
          .replace(/https?:\/\/\S+/g, "[URL]")
          .slice(0, 240);
        const retry =
          !receipts.length &&
          !(e instanceof RelayRevoked) &&
          ((!attempted && job.attempts < 3) ||
            (e instanceof RelayDeliveryError &&
              !e.ambiguous &&
              e.retryAfter &&
              job.attempts < 8));
        if (retry) {
          await query(
            "UPDATE channel_bridge_outbox SET status='queued',error=$2,next_attempt_at=now()+$3*interval '1 second' WHERE id=$1 AND status IN ('preparing','sending')",
            [job.id, message, Math.min(Math.max(e.retryAfter || 15, 5), 3600)],
          );
        } else {
          const status =
            e instanceof RelayRevoked
              ? receipts.length
                ? "review"
                : "cancelled"
              : (attempted &&
                    (!(e instanceof RelayDeliveryError) || e.ambiguous)) ||
                  receipts.length
                ? "review"
                : "failed";
          await query(
            "UPDATE channel_bridge_outbox SET status=$2,error=$3,finished_at=now() WHERE id=$1 AND status IN ('preparing','sending')",
            [job.id, status, message],
          );
        }
      } else throw error;
    } finally {
      if (temp)
        await rm(temp, { recursive: true, force: true }).catch(() => {});
      this.busy = false;
    }
  }
}
