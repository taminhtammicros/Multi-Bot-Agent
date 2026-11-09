import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { query, setting } from "./db.js";
import { encrypt, decrypt } from "./security.js";
import { getZaloPolicy } from "./zalo-policy.js";
import { replyMode } from "./reply-policy.js";
import { RelayDeliveryError, type RelayPorts } from "./channel-relay.js";
import { BridgeConnectors } from "./bridge-connectors.js";
import {
  memberSchema,
  memberPatch,
  networkPayload,
  filteredPayload,
  labels,
  conflict,
  type NetworkEnvelope,
  type BinaryMedia,
} from "./bridge-types.js";
import {
  downloadRelayFile,
  RELAY_MAX_BYTES,
  safeRelayFilename,
} from "./relay-media.js";
import { relayTextChunks } from "./relay-input.js";
class Revoked extends Error {}
export class BridgeNetwork {
  private flushing = 0;
  private polling = false;
  private healthAt = 0;
  constructor(
    readonly connectors: BridgeConnectors,
    private readonly ports: RelayPorts,
    private readonly pause = (ms: number) =>
      new Promise((r) => setTimeout(r, ms)),
    private readonly download = downloadRelayFile,
  ) {
    connectors.onMessage = (e) => this.enqueue(e);
    connectors.teams.onMessage = (e) => this.enqueue(e);
  }
  async view() {
    return {
      connections: await this.connectors.state(),
      members: (
        await query(
          "SELECT id,bridge_id,platform,account_id,chat_id,title,receive,send,images,files,enabled,checked_at,error FROM bridge_members ORDER BY created_at",
        )
      ).rows,
      contacts: (
        await query(
          "SELECT c.platform,c.account_id,c.chat_id,c.title,c.last_inbound,c.subscribed,c.chat_kind,c.discovered_at FROM bridge_contacts c JOIN bridge_connections b ON b.platform=c.platform AND b.account_id=c.account_id ORDER BY c.last_inbound DESC LIMIT 2000",
        )
      ).rows,
      stats: (
        await query(
          "SELECT bridge_id,target_platform,status,count(*)::int AS count FROM bridge_deliveries GROUP BY bridge_id,target_platform,status",
        )
      ).rows,
    };
  }
  private async room(id: string) {
    const b = (
      await query(
        "SELECT * FROM channel_bridges WHERE id=$1 AND archived_at IS NULL",
        [id],
      )
    ).rows[0];
    if (!b) throw conflict("Không tìm thấy phòng Bridge.");
    return b;
  }
  private async authorized(b: any) {
    if (!b?.enabled || b.archived_at || !b.activated_at) return false;
    const state = await this.ports.runtime();
    if (
      state.zaloAccountId !== b.zalo_account_id ||
      state.telegramBotId !== b.telegram_bot_id
    )
      return false;
    const p = await getZaloPolicy(b.zalo_account_id);
    return (
      p.groupsEnabled &&
      p.allowGroups.includes(b.zalo_group_id) &&
      (await replyMode(b.zalo_account_id, "group", b.zalo_group_id, p)) !==
        "silent"
    );
  }
  async add(bridgeId: string, raw: unknown) {
    await this.room(bridgeId);
    const input = memberSchema.parse(raw),
      row = await this.connectors.config(input.platform);
    if (!row) throw conflict("Anh cấu hình kết nối nền tảng trước.");
    if (
      Number(
        (
          await query(
            "SELECT count(*) FROM bridge_members WHERE bridge_id=$1",
            [bridgeId],
          )
        ).rows[0].count,
      ) >= 20
    )
      throw conflict("Mỗi phòng hỗ trợ tối đa 20 kênh bổ sung.");
    const id = randomUUID();
    try {
      await query(
        "INSERT INTO bridge_members(id,bridge_id,platform,account_id,chat_id,title,receive,send,images,files) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          bridgeId,
          input.platform,
          row.account_id,
          input.chatId,
          input.title,
          input.receive,
          input.send,
          input.images,
          input.files,
        ],
      );
    } catch (e: any) {
      if (e.code === "23505")
        throw conflict("Kênh này đã thuộc một phòng Bridge.");
      throw e;
    }
    return { id, enabled: false };
  }
  async update(id: string, raw: unknown) {
    const input = memberPatch.parse(raw),
      m = (await query("SELECT * FROM bridge_members WHERE id=$1", [id]))
        .rows[0];
    if (!m) throw conflict("Không tìm thấy kênh.");
    const next = { ...m, ...input };
    if (!next.receive && !next.send)
      throw conflict("Chọn ít nhất một chiều nhận/gửi.");
    let checked: any;
    if (next.enabled) {
      const b = await this.room(m.bridge_id);
      if (!(await this.authorized(b)))
        throw conflict(
          "Phòng Bridge đang tạm dừng hoặc nhóm Zalo chưa được phép.",
        );
      checked = await this.connectors.check(next);
    }
    // Revision invalidates previously queued work. Never replay old traffic when a member is enabled.
    await query(
      "UPDATE bridge_members SET title=$2,receive=$3,send=$4,images=$5,files=$6,enabled=$7,activated_at=CASE WHEN $7 THEN now() ELSE activated_at END,revision=revision+1,cursor=$8,checked_at=CASE WHEN $7 THEN now() ELSE checked_at END,error=null WHERE id=$1",
      [
        id,
        next.title,
        next.receive,
        next.send,
        next.images,
        next.files,
        next.enabled,
        checked?.cursor ?? null,
      ],
    );
    await query(
      "UPDATE bridge_deliveries SET status='cancelled',error='Cấu hình kênh đã đổi.' WHERE (source_member=$1 OR target_member=$1) AND status IN ('queued','preparing')",
      [id],
    );
    return { ok: true, note: checked?.note };
  }
  async remove(id: string) {
    await this.update(id, { enabled: false });
    await query("DELETE FROM bridge_members WHERE id=$1", [id]);
    return { ok: true };
  }
  async history(id: string) {
    await this.room(id);
    return (
      await query(
        "SELECT id,source_platform,target_platform,target_chat_id,status,attempts,error,receipts,created_at,finished_at FROM bridge_deliveries WHERE bridge_id=$1 ORDER BY seq DESC LIMIT 100",
        [id],
      )
    ).rows;
  }
  async enqueue(input: NetworkEnvelope) {
    if (!input.messageId || !Number.isFinite(input.at.getTime())) return 0;
    const payload = networkPayload.parse(input.payload);
    let rooms: any[], source: any;
    if (input.platform === "zalo" || input.platform === "telegram")
      rooms = (
        await query(
          `SELECT * FROM channel_bridges WHERE enabled AND archived_at IS NULL AND ${input.platform === "zalo" ? "zalo_account_id=$1 AND zalo_group_id=$2" : "telegram_bot_id=$1 AND telegram_chat_id=$2"}`,
          [input.accountId, input.chatId],
        )
      ).rows;
    else {
      source = (
        await query(
          "SELECT * FROM bridge_members WHERE platform=$1 AND account_id=$2 AND chat_id=$3 AND enabled AND receive",
          [input.platform, input.accountId, input.chatId],
        )
      ).rows[0];
      if (!source) return 0;
      rooms = [await this.room(source.bridge_id)];
    }
    let count = 0;
    for (const b of rooms) {
      if (
        !(await this.authorized(b)) ||
        input.at.getTime() < new Date(b.activated_at).getTime() ||
        (source && input.at.getTime() < new Date(source.activated_at).getTime())
      )
        continue;
      let selected = source ? filteredPayload(payload, source) : payload;
      if (!selected) continue;
      if (!b.media && selected.media)
        selected = selected.text ? { ...selected, media: undefined } : null;
      if (!selected) continue;
      const members = (
        await query(
          "SELECT * FROM bridge_members WHERE bridge_id=$1 AND enabled AND send",
          [b.id],
        )
      ).rows;
      const targets: any[] = members.filter((m) => m.id !== source?.id);
      // The existing worker remains the sole owner of Zalo <-> Telegram deliveries.
      if (source)
        targets.push(
          {
            platform: "zalo",
            account_id: b.zalo_account_id,
            chat_id: b.zalo_group_id,
            images: b.media,
            files: b.media,
          },
          {
            platform: "telegram",
            account_id: b.telegram_bot_id,
            chat_id: b.telegram_chat_id,
            images: b.media,
            files: b.media,
          },
        );
      for (const target of targets) {
        if (
          target.activated_at &&
          input.at.getTime() < new Date(target.activated_at).getTime()
        )
          continue;
        const p = filteredPayload(selected, target);
        if (!p) continue;
        const oversize = !!p.media?.bytes && p.media.bytes > RELAY_MAX_BYTES;
        count +=
          (
            await query(
              "INSERT INTO bridge_deliveries(id,bridge_id,source_platform,source_account_id,source_chat_id,source_message_id,source_at,source_member,source_revision,target_member,target_platform,target_account_id,target_chat_id,target_revision,activation_at,payload_cipher,status,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING",
              [
                randomUUID(),
                b.id,
                input.platform,
                input.accountId,
                input.chatId,
                input.messageId,
                input.at,
                source?.id || null,
                source?.revision || null,
                target.id || null,
                target.platform,
                target.account_id,
                target.chat_id,
                target.revision || null,
                b.activated_at,
                encrypt(JSON.stringify(p)),
                oversize ? "failed" : "queued",
                oversize ? "File vượt giới hạn Bridge 20 MB." : null,
              ],
            )
          ).rowCount || 0;
      }
    }
    return count;
  }
  async recover() {
    await query(
      "UPDATE bridge_deliveries SET status='review',error='Dịch vụ khởi động lại trong khi gửi; cần đối soát, không tự gửi lặp.',finished_at=now() WHERE status='sending'",
    );
    await query(
      "UPDATE bridge_deliveries SET status='queued' WHERE status='preparing'",
    );
    const root = resolve("data/network-tmp");
    for (const e of await readdir(root, { withFileTypes: true }).catch(
      () => [],
    ))
      if (e.isDirectory() && /^network-[a-zA-Z0-9-]+$/.test(e.name))
        await rm(join(root, e.name), { recursive: true, force: true });
  }
  private async gate(job: any) {
    const b = await this.room(job.bridge_id);
    if (
      !(await this.authorized(b)) ||
      new Date(b.activated_at).getTime() !==
        new Date(job.activation_at).getTime()
    )
      throw new Revoked("Phòng đã dừng hoặc thay đổi.");
    let source: any, target: any;
    if (job.source_member) {
      source = (
        await query("SELECT * FROM bridge_members WHERE id=$1", [
          job.source_member,
        ])
      ).rows[0];
      if (
        !source?.enabled ||
        !source.receive ||
        source.revision !== job.source_revision
      )
        throw new Revoked("Kênh nguồn đã đổi.");
    }
    if (job.target_member) {
      target = (
        await query("SELECT * FROM bridge_members WHERE id=$1", [
          job.target_member,
        ])
      ).rows[0];
      if (
        !target?.enabled ||
        !target.send ||
        target.revision !== job.target_revision
      )
        throw new Revoked("Kênh đích đã đổi.");
      const cfg = await this.connectors.config(target.platform);
      if (!cfg || cfg.account_id !== target.account_id)
        throw new Revoked("Tài khoản đích đã đổi.");
    }
    return { b, source, target };
  }
  async flush() {
    if (this.flushing >= 3) return;
    this.flushing++;
    let job: any,
      temp: string | undefined,
      attempted = false;
    const receipts: string[] = [];
    try {
      if ((await setting<any>("routing"))?.paused) return;
      await query(
        "UPDATE bridge_deliveries d SET status='cancelled',error='Phòng đã dừng, bị xóa hoặc thay đổi.',finished_at=now() FROM channel_bridges b WHERE d.bridge_id=b.id AND d.status='queued' AND (NOT b.enabled OR b.archived_at IS NOT NULL OR date_trunc('milliseconds',b.activated_at) IS DISTINCT FROM date_trunc('milliseconds',d.activation_at))",
      );
      job = (
        await query(
          `WITH chosen AS (SELECT d.id FROM bridge_deliveries d JOIN channel_bridges b ON b.id=d.bridge_id WHERE d.status='queued' AND d.next_attempt_at<=now() AND b.enabled AND b.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM bridge_deliveries old WHERE old.target_platform=d.target_platform AND old.target_account_id=d.target_account_id AND old.target_chat_id=d.target_chat_id AND old.seq<d.seq AND old.status IN ('queued','preparing','sending')) ORDER BY d.seq LIMIT 1 FOR UPDATE OF d SKIP LOCKED) UPDATE bridge_deliveries d SET status='preparing',attempts=attempts+1 FROM chosen WHERE d.id=chosen.id RETURNING d.*`,
        )
      ).rows[0];
      if (!job) return;
      let { b, target } = await this.gate(job);
      const state = await this.ports.runtime();
      if (
        (job.target_platform === "zalo" && !state.zaloConnected) ||
        (job.target_platform === "telegram" && !state.telegramReceiving)
      ) {
        await query(
          "UPDATE bridge_deliveries SET status='queued',attempts=attempts-1,next_attempt_at=now()+interval '10 seconds',error='Kênh đích đang mất kết nối.' WHERE id=$1 AND status='preparing'",
          [job.id],
        );
        return;
      }
      if (job.target_platform === "telegram") {
        const check = await this.ports.checkTelegram(job.target_chat_id);
        if (!check.member || !check.canSend)
          throw new Revoked("Bot Telegram không còn quyền gửi.");
      }
      const payload = networkPayload.parse(
        JSON.parse(decrypt(job.payload_cipher)),
      );
      let media: BinaryMedia | undefined, path: string | undefined;
      if (payload.media) {
        const m = payload.media;
        let loaded: { data: Buffer; mime: string };
        if (job.source_platform === "telegram")
          loaded = await this.ports.telegramFile(m.fileId!);
        else if (job.source_platform === "whatsapp")
          loaded = await this.connectors.loadWhatsApp(m.fileId!);
        else if (m.url) loaded = await this.download(m.url);
        else throw new Error("Thiếu nguồn tải file.");
        if (loaded.data.length > RELAY_MAX_BYTES)
          throw new Error("File vượt giới hạn Bridge 20 MB.");
        media = { ...loaded, name: safeRelayFilename(m.name), kind: m.kind };
        if (job.target_platform === "zalo") {
          const root = resolve("data/network-tmp");
          await mkdir(root, { recursive: true, mode: 0o700 });
          temp = await mkdtemp(join(root, "network-"));
          path = join(temp, media.name);
          await writeFile(path, media.data, { mode: 0o600 });
        }
      }
      const prefix =
        "[" +
        labels[job.source_platform as keyof typeof labels] +
        "]\n" +
        payload.sender +
        ":";
      const textParts = relayTextChunks(prefix + "\n" + payload.text, 1900);
      const parts: { text: string; media?: BinaryMedia }[] = textParts.map(
        (text) => ({ text }),
      );
      if (media) parts.push({ text: prefix, media });
      for (let i = 0; i < parts.length; i++) {
        if (i) await this.pause(3100);
        ({ b, target } = await this.gate(job));
        if ((await setting<any>("routing"))?.paused)
          throw new Revoked("Bridge đang tạm dừng.");
        const claim = await query(
          "UPDATE bridge_deliveries SET status='sending' WHERE id=$1 AND status IN ('preparing','sending')",
          [job.id],
        );
        if (!claim.rowCount) throw new Revoked("Tác vụ đã hủy.");
        attempted = true;
        const p = parts[i];
        let receipt: string;
        if (job.target_platform === "zalo")
          receipt = await this.ports.sendZalo(
            job.target_chat_id,
            p.text,
            p.media ? path : undefined,
          );
        else if (job.target_platform === "telegram")
          receipt = await this.ports.sendTelegram(
            job.target_chat_id,
            p.text,
            p.media,
          );
        else receipt = await this.connectors.send(target, p.text, p.media);
        if (!receipt)
          throw new RelayDeliveryError("Kênh đích chưa xác nhận ID tin.", true);
        receipts.push(receipt);
        await query(
          "UPDATE bridge_deliveries SET receipts=$2::jsonb WHERE id=$1",
          [job.id, JSON.stringify(receipts)],
        );
      }
      await query(
        "UPDATE bridge_deliveries SET status='sent',error=null,finished_at=now() WHERE id=$1 AND status='sending'",
        [job.id],
      );
      await query(
        "UPDATE bridge_deliveries SET next_attempt_at=GREATEST(next_attempt_at,now()+interval '3.1 seconds') WHERE target_platform=$1 AND target_account_id=$2 AND target_chat_id=$3 AND status='queued'",
        [job.target_platform, job.target_account_id, job.target_chat_id],
      );
    } catch (e: any) {
      if (!job) throw e;
      const error = String(e?.message || "Không chuyển được tin.")
        .replace(/https?:\/\/\S+/g, "[URL]")
        .slice(0, 240);
      const retry =
        !receipts.length &&
        !(e instanceof Revoked) &&
        ((!attempted && job.attempts < 3) ||
          (e instanceof RelayDeliveryError &&
            !e.ambiguous &&
            e.retryAfter &&
            job.attempts < 8));
      if (retry)
        await query(
          "UPDATE bridge_deliveries SET status='queued',error=$2,next_attempt_at=now()+$3*interval '1 second' WHERE id=$1 AND status IN ('preparing','sending')",
          [job.id, error, Math.min(Math.max(e.retryAfter || 15, 5), 3600)],
        );
      else {
        const status =
          e instanceof Revoked
            ? receipts.length
              ? "review"
              : "cancelled"
            : receipts.length ||
                (attempted &&
                  (!(e instanceof RelayDeliveryError) || e.ambiguous))
              ? "review"
              : "failed";
        await query(
          "UPDATE bridge_deliveries SET status=$2,error=$3,finished_at=now() WHERE id=$1 AND status IN ('preparing','sending')",
          [job.id, status, error],
        );
      }
    } finally {
      if (temp)
        await rm(temp, { recursive: true, force: true }).catch(() => {});
      this.flushing--;
    }
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      if (Date.now() - this.healthAt > 60000) {
        this.healthAt = Date.now();
        for (const row of (
          await query("SELECT platform FROM bridge_connections")
        ).rows)
          await this.connectors.checkConnection(row.platform).catch(() => {});
        await query("DELETE FROM bridge_media WHERE expires_at<now()");
      }
      if ((await setting<any>("routing"))?.paused) return;
      if (
        !['coccoc_mac','vps_brave'].includes((await this.connectors.config("teams_personal"))?.config.transport) &&
        !this.connectors.teams.state().open &&
        (
          await query(
            "SELECT 1 FROM bridge_members m JOIN channel_bridges b ON b.id=m.bridge_id WHERE m.platform='teams_personal' AND m.enabled AND b.enabled AND b.archived_at IS NULL LIMIT 1",
          )
        ).rowCount
      )
        await this.connectors.teams.open();
      const members = (
        await query(
          "SELECT m.* FROM bridge_members m JOIN channel_bridges b ON b.id=m.bridge_id WHERE m.enabled AND m.receive AND m.next_poll_at<=now() AND m.platform IN ('discord','teams_personal') AND b.enabled AND b.archived_at IS NULL ORDER BY m.next_poll_at LIMIT 20",
        )
      ).rows;
      for (const m of members) {
        try {
          const b = await this.room(m.bridge_id);
          if (!(await this.authorized(b))) continue;
          if (m.platform === "discord") await this.connectors.pollDiscord(m);
          else {
            const c = await this.connectors.config("teams_personal");
            await this.connectors.teams.poll(m, c?.config.selfName || "");
          }
        } catch (e: any) {
          await query(
            "UPDATE bridge_members SET error=$2,checked_at=now(),next_poll_at=now()+interval '30 seconds' WHERE id=$1",
            [
              m.id,
              String(e?.message || "Không nhận được tin.")
                .replace(/https?:\/\/\S+/g, "[URL]")
                .slice(0, 240),
            ],
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
