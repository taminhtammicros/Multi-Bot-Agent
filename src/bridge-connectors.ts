import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { query } from "./db.js";
import { encrypt, decrypt } from "./security.js";
import { RelayDeliveryError } from "./channel-relay.js";
import {
  downloadRelayFile,
  RELAY_MAX_BYTES,
  safeRelayFilename,
} from "./relay-media.js";
import {
  extraPlatform,
  clean,
  conflict,
  type ExtraPlatform,
  type NetworkEnvelope,
  type BinaryMedia,
} from "./bridge-types.js";
import type { TeamsPersonal } from "./teams-personal.js";
const configSchema = z
  .object({
    token: z.string().trim().max(4096).optional(),
    transport: z.enum(["vps_browser", "vps_brave", "coccoc_mac"]).optional(),
    workerToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    phoneNumberId: z
      .string()
      .regex(/^\d{5,30}$/)
      .optional(),
    appSecret: z.string().trim().max(256).optional(),
    verifyToken: z.string().trim().min(16).max(256).optional(),
    publicBaseUrl: z.string().url().max(512).optional(),
    apiVersion: z
      .string()
      .regex(/^v\d{2}\.0$/)
      .default("v24.0"),
    selfName: z.string().trim().max(100).optional(),
  })
  .strict();
export function validSignature(
  raw: string,
  signature: string | undefined,
  secret: string,
  prefix = "",
) {
  if (!secret || !signature?.startsWith(prefix)) return false;
  const provided = signature.slice(prefix.length);
  if (!/^[a-f\d]{64}$/i.test(provided)) return false;
  return timingSafeEqual(
    Buffer.from(provided, "hex"),
    createHmac("sha256", secret).update(raw).digest(),
  );
}
// Preserve 64-bit Viber tokens before JSON parsing. JS numbers cannot represent them exactly.
export function providerJSON(raw: string) {
  return JSON.parse(raw.replace(/("message_token"\s*:\s*)(\d+)/g, '$1"$2"'));
}
export function discordEnvelopes(m: any, accountId: string): NetworkEnvelope[] {
  if (
    !m?.id ||
    !m.channel_id ||
    !m.author ||
    m.author.bot ||
    m.webhook_id ||
    ![0, 19].includes(m.type)
  )
    return [];
  const attachments = Array.isArray(m.attachments) ? m.attachments : [];
  const base = {
    platform: "discord" as const,
    accountId,
    chatId: String(m.channel_id),
    at: new Date(m.timestamp),
  };
  const payload = {
    sender: clean(
      m.member?.nick || m.author.global_name || m.author.username,
      100,
    ),
    sourceName: "",
    text: clean(m.content),
  };
  if (!attachments.length)
    return payload.text ? [{ ...base, messageId: String(m.id), payload }] : [];
  return attachments.map((a: any, i: number) => ({
    ...base,
    messageId: String(m.id) + ":" + String(a.id),
    payload: {
      ...payload,
      text: i === 0 ? payload.text : "",
      media: {
        kind: a.content_type?.startsWith("image/")
          ? ("image" as const)
          : ("file" as const),
        name: clean(a.filename || "attachment.bin", 160),
        url: String(a.url || ""),
        bytes: Number(a.size) || undefined,
        mime: a.content_type,
      },
    },
  }));
}
export class BridgeConnectors {
  onMessage?: (e: NetworkEnvelope) => Promise<unknown>;
  constructor(
    readonly teams: TeamsPersonal,
    private readonly request: typeof fetch = fetch,
  ) {}
  async config(platform: ExtraPlatform) {
    const row = (
      await query("SELECT * FROM bridge_connections WHERE platform=$1", [
        platform,
      ])
    ).rows[0];
    return row
      ? { ...row, config: JSON.parse(decrypt(row.config_cipher)) }
      : null;
  }
  async state() {
    const rows = (
      await query(
        "SELECT platform,account_id,checked_at,received_at,error FROM bridge_connections",
      )
    ).rows;
    return Promise.all(
      extraPlatform.options.map(async (platform) => {
        const row = rows.find((r) => r.platform === platform);
        const cfg = row ? await this.config(platform) : null;
        return {
          platform,
          configured: !!row,
          accountId: row?.account_id || null,
          checkedAt: row?.checked_at || null,
          receivedAt: row?.received_at || null,
          error: row?.error || null,
          publicBaseUrl: cfg?.config.publicBaseUrl || "",
          phoneNumberId: cfg?.config.phoneNumberId || "",
          selfName: cfg?.config.selfName || "",
          transport: cfg?.config.transport || "vps_browser",
          apiVersion: cfg?.config.apiVersion || "v24.0",
          webhookPath:
            platform === "viber" || platform === "whatsapp"
              ? "/relay-hooks/" + platform
              : null,
          mode:
            platform === "teams_personal"
              ? "experimental_browser"
              : platform === "discord"
                ? "bot_channel"
                : "bot_private",
          ...(platform === "teams_personal"
            ? {
                browser:
                  cfg?.config.transport === "coccoc_mac"
                    ? { mode: "coccoc_mac", open: !row?.error }
                    : this.teams.state(),
              }
            : {}),
          capabilities:
            platform === "teams_personal"
              ? { text: true, images: false, files: false }
              : { text: true, images: true, files: true },
        };
      }),
    );
  }
  private async call(
    url: string,
    token: string,
    method = "GET",
    body?: unknown,
    flavor: "discord" | "whatsapp" | "viber" = "discord",
  ) {
    let response: Response;
    try {
      response = await this.request(url, {
        method,
        headers: {
          ...(flavor === "viber"
            ? { "X-Viber-Auth-Token": token }
            : {
                Authorization:
                  (flavor === "discord" ? "Bot " : "Bearer ") + token,
              }),
          ...(body && !(body instanceof FormData)
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(body
          ? { body: body instanceof FormData ? body : JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(body instanceof FormData ? 120000 : 20000),
        redirect: "error",
      });
    } catch {
      throw new RelayDeliveryError(
        labelsFor(flavor) +
          " không xác nhận kết nối. Kiểm tra trạng thái trước khi gửi lại.",
        true,
      );
    }
    let result: any;
    try {
      result = providerJSON(await response.text());
    } catch {
      throw new RelayDeliveryError(
        labelsFor(flavor) + " trả phản hồi không hợp lệ.",
        true,
      );
    }
    if (!response.ok || (flavor === "viber" && result.status !== 0))
      throw new RelayDeliveryError(
        labelsFor(flavor) +
          " từ chối yêu cầu (HTTP " +
          response.status +
          ", mã " +
          String(
            result?.error?.code ?? result?.code ?? result?.status ?? "unknown",
          ).slice(0, 30) +
          ").",
        response.status >= 500 || response.status === 408,
        response.status === 429
          ? Math.ceil(Number(result.retry_after) || 30)
          : undefined,
      );
    return result;
  }
  private discord(path: string, c: any, method = "GET", body?: unknown) {
    return this.call(
      "https://discord.com/api/v10" + path,
      c.token,
      method,
      body,
      "discord",
    );
  }
  private graph(path: string, c: any, method = "GET", body?: unknown) {
    return this.call(
      "https://graph.facebook.com/" + c.apiVersion + "/" + path,
      c.token,
      method,
      body,
      "whatsapp",
    );
  }
  private viber(method: string, c: any, body: any = {}) {
    return this.call(
      "https://chatapi.viber.com/pa/" + method,
      c.token,
      "POST",
      body,
      "viber",
    );
  }
  async configure(platform: ExtraPlatform, raw: unknown) {
    const input = configSchema.parse(raw),
      old = await this.config(platform),
      c = { ...old?.config, ...input };
    for (const key of ["token", "appSecret", "verifyToken", "workerToken"])
      if (!(input as any)[key] && old?.config[key]) c[key] = old.config[key];
    if (c.publicBaseUrl) {
      const u = new URL(c.publicBaseUrl);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.pathname !== "/" ||
        u.search ||
        u.hash ||
        u.port
      )
        throw conflict(
          "Địa chỉ webhook phải là gốc HTTPS, không kèm đường dẫn.",
        );
      c.publicBaseUrl = u.origin;
    }
    let accountId: string;
    if (platform === "discord") {
      if (!c.token) throw conflict("Cần Discord Bot token.");
      const me = await this.discord("/users/@me", c);
      if (!me.bot || !me.id) throw conflict("Chỉ dùng Discord Bot token.");
      accountId = String(me.id);
    } else if (platform === "viber") {
      if (!c.token) throw conflict("Cần Viber Bot token.");
      const me = await this.viber("get_account_info", c);
      if (!me.id) throw conflict("Viber chưa xác nhận bot.");
      accountId = String(me.id);
    } else if (platform === "whatsapp") {
      if (!c.token || !c.phoneNumberId || !c.appSecret || !c.verifyToken)
        throw conflict(
          "Cần access token, Phone Number ID, App Secret và Verify Token.",
        );
      const me = await this.graph(
        c.phoneNumberId + "?fields=id,display_phone_number,verified_name",
        c,
      );
      if (String(me.id) !== c.phoneNumberId)
        throw conflict("WhatsApp Phone Number ID không khớp.");
      accountId = String(me.id);
    } else {
      if (!c.selfName)
        throw conflict(
          "Nhập đúng tên hiển thị tài khoản Teams Personal của anh để chống chuyển vòng.",
        );
      if (c.transport === "coccoc_mac") {
        const remote = await this.teams.macState(c);
        if (remote.selfName !== c.selfName)
          throw conflict("Tên tài khoản Cốc Cốc chưa khớp.");
        accountId = remote.accountId;
      } else {
        let state:any;try{state=await this.teams.browserState();}catch{}
        if(state?.authenticated){if(state.selfName!==c.selfName)throw conflict('Tên hiển thị chưa khớp tài khoản Teams trên VPS.');accountId=state.accountId;}
        else {if(c.transport==='vps_brave')throw conflict('Cần kết nối và đăng nhập Teams trong Brave VPS trước.');accountId='personal';}
      }
    }
    const changed =
      old &&
      (old.account_id !== accountId ||
        ["token", "appSecret", "selfName", "workerToken", "transport"].some(
          (k) => c[k] !== old.config[k],
        ));
    await query(
      "INSERT INTO bridge_connections(platform,config_cipher,account_id,checked_at) VALUES($1,$2,$3,now()) ON CONFLICT(platform) DO UPDATE SET config_cipher=EXCLUDED.config_cipher,account_id=EXCLUDED.account_id,checked_at=now(),error=null,updated_at=now()",
      [platform, encrypt(JSON.stringify(c)), accountId],
    );
    if (changed) {
      await query(
        "UPDATE bridge_members SET enabled=false,revision=revision+1,error=$2 WHERE platform=$1",
        [
          platform,
          "Tài khoản hoặc thông tin xác thực thay đổi. Kiểm tra rồi bật lại kênh.",
        ],
      );
      await query(
        "UPDATE bridge_deliveries SET status='cancelled',error='Kết nối thay đổi.' WHERE status IN ('queued','preparing') AND (source_platform=$1 OR target_platform=$1)",
        [platform],
      );
    }
    return {
      saved: true,
      accountId,
      needsWebhook: ["viber", "whatsapp"].includes(platform),
      needsLogin: platform === "teams_personal",
    };
  }
  async disconnect(platform: ExtraPlatform) {
    await query(
      "UPDATE bridge_members SET enabled=false,revision=revision+1 WHERE platform=$1",
      [platform],
    );
    await query(
      "UPDATE bridge_deliveries SET status='cancelled',error='Kênh đã ngắt.' WHERE status IN ('queued','preparing') AND (source_platform=$1 OR target_platform=$1)",
      [platform],
    );
    await query("DELETE FROM bridge_connections WHERE platform=$1", [platform]);
    if (platform === "teams_personal") await this.teams.close();
    return { ok: true };
  }
  async check(member: any) {
    const row = await this.config(member.platform);
    if (!row || row.account_id !== member.account_id)
      throw conflict("Chưa cấu hình hoặc tài khoản đã đổi.");
    const c = row.config;
    if (member.platform === "discord") {
      if (!/^\d{15,22}$/.test(member.chat_id))
        throw conflict("Discord Channel ID không hợp lệ.");
      const ch = await this.discord("/channels/" + member.chat_id, c);
      if (![0, 5].includes(ch.type) || !ch.guild_id)
        throw conflict("Chọn text channel trong Discord server.");
      const [roles, me] = await Promise.all([
        this.discord("/guilds/" + ch.guild_id + "/roles", c),
        this.discord(
          "/guilds/" + ch.guild_id + "/members/" + row.account_id,
          c,
        ),
      ]);
      let p = 0n;
      for (const r of roles)
        if (r.id === ch.guild_id || me.roles.includes(r.id))
          p |= BigInt(r.permissions);
      if (!(p & 8n)) {
        const overwrites = ch.permission_overwrites || [],
          everyone = overwrites.find((o: any) => o.id === ch.guild_id);
        if (everyone) p = (p & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
        let allow = 0n,
          deny = 0n;
        for (const o of overwrites)
          if (o.type === 0 && me.roles.includes(o.id)) {
            deny |= BigInt(o.deny);
            allow |= BigInt(o.allow);
          }
        p = (p & ~deny) | allow;
        const own = overwrites.find(
          (o: any) => o.type === 1 && o.id === row.account_id,
        );
        if (own) p = (p & ~BigInt(own.deny)) | BigInt(own.allow);
        const required =
          1024n |
          (member.receive ? 65536n : 0n) |
          (member.send ? 2048n : 0n) |
          (member.send && (member.images || member.files) ? 32768n : 0n);
        if ((p & required) !== required)
          throw conflict(
            "Bot cần View Channel, Read Message History, Send Messages và Attach Files theo chiều đã chọn.",
          );
      }
      const latest = await this.discord(
        "/channels/" + member.chat_id + "/messages?limit=1",
        c,
      );
      return {
        title: ch.name,
        cursor: latest[0]?.id || snowflakeNow(),
        note: "Đã kiểm tra quyền channel; cần bật Message Content Intent trong Discord Developer Portal.",
      };
    }
    if (member.platform === "teams_personal") {
      if (member.images || member.files)
        throw conflict(
          "Teams Personal thử nghiệm hiện chỉ hỗ trợ văn bản; bỏ chọn ảnh/file.",
        );
      return this.teams.check(member, c.selfName);
    }
    const contact = (
      await query(
        "SELECT * FROM bridge_contacts WHERE platform=$1 AND account_id=$2 AND chat_id=$3",
        [member.platform, row.account_id, member.chat_id],
      )
    ).rows[0];
    if (!contact?.subscribed)
      throw conflict(
        "Người nhận phải nhắn vào bot trước để Hub nhận diện. Viber/WhatsApp hiện dùng chat riêng, chưa hỗ trợ nhóm.",
      );
    if (member.platform === "whatsapp" && !/^\d{7,16}$/.test(member.chat_id))
      throw conflict("WhatsApp dùng số điện thoại quốc tế, chỉ gồm chữ số.");
    if (member.platform === "viber" && member.send && !c.publicBaseUrl)
      throw conflict("Cần địa chỉ webhook HTTPS công khai cho Viber.");
    return {
      title: contact.title,
      note:
        member.platform === "whatsapp"
          ? "Gửi trong cửa sổ chăm sóc 24 giờ sau tin nhắn của người nhận."
          : "Người nhận đã được nhận diện.",
    };
  }
  async installWebhook(platform: ExtraPlatform) {
    const row = await this.config(platform);
    if (!row) throw conflict("Chưa cấu hình.");
    const c = row.config;
    if (!c.publicBaseUrl) throw conflict("Chưa có địa chỉ HTTPS công khai.");
    if (platform === "viber") {
      await this.viber("set_webhook", c, {
        url: c.publicBaseUrl + "/relay-hooks/viber",
        event_types: ["message", "subscribed", "unsubscribed", "failed"],
        send_name: true,
        send_photo: false,
      });
      return { ok: true };
    }
    if (platform === "whatsapp")
      return {
        url: c.publicBaseUrl + "/relay-hooks/whatsapp",
        note: "Thiết lập Callback URL và Verify Token trong Meta App, subscribe trường messages của WhatsApp Business Account.",
      };
    throw conflict("Nền tảng này không dùng webhook.");
  }
  async refreshTeamsDirectory() {
    const connection = await this.config('teams_personal');
    if (!connection) throw conflict('Chưa cấu hình Teams Personal.');
    if (connection.config.transport === 'coccoc_mac') throw conflict('Tải danh sách hiện hỗ trợ phiên Teams trên VPS.');
    const directory = await this.teams.refreshDirectory();
    if (directory.accountId.toLowerCase() !== connection.account_id.toLowerCase()) throw conflict('Teams đang đăng nhập tài khoản khác cấu hình.');
    // Persist metadata only; never create or enable bridge members.
    await query(`INSERT INTO bridge_contacts(platform,account_id,chat_id,title,chat_kind,discovered_at)
      SELECT 'teams_personal',$1,x.chat_id,x.title,x.kind,now()
      FROM jsonb_to_recordset($2::jsonb) AS x(chat_id text,title text,kind text)
      WHERE EXISTS (SELECT 1 FROM bridge_connections WHERE platform='teams_personal' AND account_id=$1)
      ON CONFLICT(platform,account_id,chat_id) DO UPDATE SET title=EXCLUDED.title,chat_kind=EXCLUDED.chat_kind,discovered_at=EXCLUDED.discovered_at`,
      [connection.account_id,JSON.stringify(directory.chats.map((chat:any)=>({chat_id:'https://teams.live.com/v2/?chatId='+encodeURIComponent(chat.chatId),title:chat.title,kind:chat.kind})))]);
    const contacts = (await query("SELECT c.* FROM bridge_contacts c JOIN bridge_connections b ON b.platform=c.platform AND b.account_id=c.account_id WHERE c.platform='teams_personal' AND c.account_id=$1 ORDER BY c.title",[connection.account_id])).rows;
    return {contacts,count:directory.chats.length,partial:directory.partial,collapsedFolders:directory.collapsedFolders};
  }
  async checkConnection(platform: ExtraPlatform) {
    const row = await this.config(platform);
    if (!row) throw conflict("Chưa cấu hình.");
    try {
      if (platform === "discord") await this.discord("/users/@me", row.config);
      else if (platform === "viber")
        await this.viber("get_account_info", row.config);
      else if (platform === "whatsapp")
        await this.graph(row.account_id + "?fields=id", row.config);
      else {
        if (row.config.transport === "coccoc_mac") {
          const browser = await this.teams.macState(row.config);
          if (
            browser.accountId !== row.account_id ||
            browser.selfName !== row.config.selfName
          )
            throw conflict("Cốc Cốc đã đổi tài khoản hoặc tên hiển thị.");
          if (browser.chatId && browser.title)
            await query(
              "INSERT INTO bridge_contacts(platform,account_id,chat_id,title) VALUES('teams_personal',$1,$2,$3) ON CONFLICT(platform,account_id,chat_id) DO UPDATE SET title=EXCLUDED.title",
              [
                row.account_id,
                "https://teams.live.com/v2/?chatId=" +
                  encodeURIComponent(browser.chatId),
                browser.title,
              ],
            );
          await query(
            "UPDATE bridge_connections SET checked_at=now(),error=null WHERE platform=$1",
            [platform],
          );
          return { ok: true, browser };
        }
        const browser=await this.teams.browserState();
        if(!browser.authenticated||browser.selfName!==row.config.selfName||(row.account_id!=='personal'&&browser.accountId!==row.account_id))throw conflict('Teams trên VPS chưa đăng nhập đúng tài khoản đã cấu hình.');
        if(browser.chatId&&browser.title)await query("INSERT INTO bridge_contacts(platform,account_id,chat_id,title) VALUES('teams_personal',$1,$2,$3) ON CONFLICT(platform,account_id,chat_id) DO UPDATE SET title=EXCLUDED.title",[row.account_id,'https://teams.live.com/v2/?chatId='+encodeURIComponent(browser.chatId),browser.title]);
        await query('UPDATE bridge_connections SET checked_at=now(),error=null WHERE platform=$1',[platform]);
        return {ok:true,browser};
      }
      await query(
        "UPDATE bridge_connections SET checked_at=now(),error=null WHERE platform=$1",
        [platform],
      );
      return { ok: true };
    } catch (e) {
      await this.recordError(platform, e);
      throw e;
    }
  }
  async recordError(platform: string, e: unknown) {
    await query(
      "UPDATE bridge_connections SET checked_at=now(),error=$2 WHERE platform=$1",
      [
        platform,
        e instanceof Error
          ? e.message.slice(0, 220)
          : "Không kiểm tra được kết nối.",
      ],
    );
  }
  async pollDiscord(member: any) {
    const row = await this.config("discord");
    if (!row || row.account_id !== member.account_id) return;
    const cursor = member.cursor || snowflakeNow(),
      messages = await this.discord(
        "/channels/" +
          member.chat_id +
          "/messages?limit=100&after=" +
          encodeURIComponent(cursor),
        row.config,
      );
    messages.sort((a: any, b: any) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const m of messages) {
      for (const e of discordEnvelopes(m, row.account_id))
        await this.onMessage?.(e);
      await query(
        "UPDATE bridge_members SET cursor=$2 WHERE id=$1 AND revision=$3",
        [member.id, String(m.id), member.revision],
      );
    }
    await query(
      "UPDATE bridge_members SET checked_at=now(),error=null,next_poll_at=now()+interval '5 seconds' WHERE id=$1 AND revision=$2",
      [member.id, member.revision],
    );
  }
  async webhook(
    platform: "whatsapp" | "viber",
    raw: string,
    signature: string | undefined,
  ) {
    const row = await this.config(platform);
    if (
      !row ||
      !validSignature(
        raw,
        signature,
        platform === "viber" ? row.config.token : row.config.appSecret,
        platform === "whatsapp" ? "sha256=" : "",
      )
    )
      throw Object.assign(new Error("Chữ ký webhook không hợp lệ."), {
        statusCode: 401,
      });
    const body = providerJSON(raw);
    if (platform === "viber") {
      if (body.event === "unsubscribed") {
        await query(
          "UPDATE bridge_contacts SET subscribed=false WHERE platform=$1 AND account_id=$2 AND chat_id=$3",
          [platform, row.account_id, String(body.user_id)],
        );
        return;
      }
      if (body.event === "failed") {
        await this.deliveryFailure(
          platform,
          String(body.message_token),
          "Viber báo gửi thất bại.",
        );
        return;
      }
      if (body.event !== "message" || !body.sender?.id || !body.message_token)
        return;
      const m = body.message,
        sender = String(body.sender.id);
      await this.contact(
        platform,
        row.account_id,
        sender,
        clean(body.sender.name || sender, 100),
      );
      if (!["text", "picture", "file"].includes(m?.type)) return;
      const media =
        m.type === "text"
          ? undefined
          : {
              kind:
                m.type === "picture" ? ("image" as const) : ("file" as const),
              name: clean(
                m.file_name ||
                  (m.type === "picture" ? "image.jpg" : "attachment.bin"),
                160,
              ),
              url: String(m.media || ""),
              bytes: Number(m.file_size) || undefined,
            };
      await this.onMessage?.({
        platform,
        accountId: row.account_id,
        chatId: sender,
        messageId: String(body.message_token),
        at: new Date(Number(body.timestamp)),
        payload: {
          sender: clean(body.sender.name || sender, 100),
          sourceName: "Viber",
          text: clean(m.text),
          ...(media ? { media } : {}),
        },
      });
    } else {
      for (const entry of body.entry || [])
        for (const change of entry.changes || []) {
          const v = change.value;
          if (String(v?.metadata?.phone_number_id) !== row.account_id) continue;
          for (const status of v.statuses || [])
            if (status.status === "failed")
              await this.deliveryFailure(
                platform,
                String(status.id),
                "WhatsApp báo gửi thất bại, mã " +
                  String(status.errors?.[0]?.code || "unknown") +
                  ".",
              );
          for (const m of v.messages || []) {
            const sender = String(m.from || "");
            if (!/^\d{7,16}$/.test(sender) || !m.id) continue;
            const name = clean(
              v.contacts?.find((x: any) => x.wa_id === sender)?.profile?.name ||
                sender,
              100,
            );
            await this.contact(
              platform,
              row.account_id,
              sender,
              name,
              new Date(Number(m.timestamp) * 1000),
            );
            if (!["text", "image", "document"].includes(m.type)) continue;
            const item = m[m.type],
              media =
                m.type === "text"
                  ? undefined
                  : {
                      kind:
                        m.type === "image"
                          ? ("image" as const)
                          : ("file" as const),
                      name: clean(
                        item.filename ||
                          (m.type === "image" ? "image.jpg" : "attachment.bin"),
                        160,
                      ),
                      fileId: String(item.id),
                      mime: item.mime_type,
                    };
            await this.onMessage?.({
              platform,
              accountId: row.account_id,
              chatId: sender,
              messageId: String(m.id),
              at: new Date(Number(m.timestamp) * 1000),
              payload: {
                sender: name,
                sourceName: "WhatsApp",
                text: clean(m.type === "text" ? item.body : item.caption),
                ...(media ? { media } : {}),
              },
            });
          }
        }
    }
    await query(
      "UPDATE bridge_connections SET received_at=now(),error=null WHERE platform=$1",
      [platform],
    );
  }
  private async contact(
    platform: string,
    account: string,
    chat: string,
    title: string,
    at = new Date(),
  ) {
    await query(
      "INSERT INTO bridge_contacts(platform,account_id,chat_id,title,last_inbound) VALUES($1,$2,$3,$4,$5) ON CONFLICT(platform,account_id,chat_id) DO UPDATE SET title=EXCLUDED.title,last_inbound=GREATEST(bridge_contacts.last_inbound,EXCLUDED.last_inbound),subscribed=true",
      [platform, account, chat, title, at],
    );
  }
  private async deliveryFailure(
    platform: string,
    receipt: string,
    error: string,
  ) {
    await query(
      "UPDATE bridge_deliveries SET status='failed',error=$3 WHERE target_platform=$1 AND receipts ? $2 AND status IN ('sent','sending')",
      [platform, receipt, error],
    );
  }
  async loadWhatsApp(fileId: string) {
    const row = await this.config("whatsapp");
    if (!row) throw conflict("WhatsApp đã ngắt.");
    if (!/^\d{1,40}$/.test(fileId)) throw conflict("Media ID không hợp lệ.");
    const meta = await this.graph(fileId, row.config);
    if (Number(meta.file_size) > RELAY_MAX_BYTES)
      throw conflict("File vượt giới hạn Bridge 20 MB.");
    const u = new URL(meta.url);
    if (u.protocol !== "https:" || u.hostname !== "lookaside.fbsbx.com")
      throw conflict("Nguồn media WhatsApp không hợp lệ.");
    let response: Response;
    try {
      response = await this.request(u, {
        headers: { Authorization: "Bearer " + row.config.token },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw conflict("Không tải được media WhatsApp.");
    }
    if (!response.ok) throw conflict("WhatsApp từ chối tải media.");
    const reader = response.body?.getReader();
    if (!reader) throw conflict("Media rỗng.");
    let bytes = 0;
    const parts: Uint8Array[] = [];
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        bytes += r.value.length;
        if (bytes > RELAY_MAX_BYTES)
          throw conflict("File vượt giới hạn Bridge 20 MB.");
        parts.push(r.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return {
      data: Buffer.concat(parts),
      mime: meta.mime_type || "application/octet-stream",
    };
  }
  async send(member: any, text: string, media?: BinaryMedia): Promise<string> {
    const row = await this.config(member.platform);
    if (!row || row.account_id !== member.account_id)
      throw new RelayDeliveryError("Tài khoản kênh đã thay đổi.", false);
    const c = row.config;
    if (member.platform === "teams_personal") {
      if (media)
        throw new RelayDeliveryError(
          "Teams Personal chưa hỗ trợ ảnh/file.",
          false,
        );
      return this.teams.send(member, text, c.selfName);
    }
    if (member.platform === "discord") {
      const content = { content: text, allowed_mentions: { parse: [] } };
      let result: any;
      if (media) {
        const form = new FormData();
        form.set(
          "payload_json",
          JSON.stringify({
            ...content,
            attachments: [{ id: 0, filename: media.name }],
          }),
        );
        form.set(
          "files[0]",
          new Blob([new Uint8Array(media.data)], { type: media.mime }),
          media.name,
        );
        result = await this.discord(
          "/channels/" + member.chat_id + "/messages",
          c,
          "POST",
          form,
        );
      } else
        result = await this.discord(
          "/channels/" + member.chat_id + "/messages",
          c,
          "POST",
          content,
        );
      if (!result.id)
        throw new RelayDeliveryError("Discord chưa xác nhận ID tin.", true);
      return String(result.id);
    }
    if (member.platform === "whatsapp") {
      const contact = (
        await query(
          "SELECT last_inbound,subscribed FROM bridge_contacts WHERE platform='whatsapp' AND account_id=$1 AND chat_id=$2",
          [row.account_id, member.chat_id],
        )
      ).rows[0];
      if (
        !contact?.subscribed ||
        Date.now() - new Date(contact.last_inbound).getTime() > 24 * 3600000
      )
        throw new RelayDeliveryError(
          "WhatsApp đã hết cửa sổ 24 giờ. Người nhận cần nhắn lại; Bridge không tự gửi template.",
          false,
        );
      let body: any = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: member.chat_id,
        type: "text",
        text: { body: text, preview_url: false },
      };
      if (media) {
        const form = new FormData();
        form.set("messaging_product", "whatsapp");
        form.set("type", media.mime);
        form.set(
          "file",
          new Blob([new Uint8Array(media.data)], { type: media.mime }),
          media.name,
        );
        const uploaded = await this.graph(
          row.account_id + "/media",
          c,
          "POST",
          form,
        );
        if (!uploaded.id)
          throw new RelayDeliveryError(
            "WhatsApp chưa xác nhận tải file.",
            false,
          );
        const image =
          media.kind === "image" &&
          ["image/jpeg", "image/png"].includes(media.mime) &&
          media.data.length <= 5 * 1024 * 1024;
        const type = image ? "image" : "document";
        body = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: member.chat_id,
          type,
          [type]: {
            id: uploaded.id,
            caption: text,
            ...(image ? {} : { filename: media.name }),
          },
        };
      }
      const result = await this.graph(
        row.account_id + "/messages",
        c,
        "POST",
        body,
      );
      if (!result.messages?.[0]?.id)
        throw new RelayDeliveryError("WhatsApp chưa xác nhận ID tin.", true);
      return String(result.messages[0].id);
    }
    const contact = (
      await query(
        "SELECT subscribed FROM bridge_contacts WHERE platform='viber' AND account_id=$1 AND chat_id=$2",
        [row.account_id, member.chat_id],
      )
    ).rows[0];
    if (!contact?.subscribed)
      throw new RelayDeliveryError("Người nhận Viber đã hủy đăng ký.", false);
    let body: any = {
      receiver: member.chat_id,
      min_api_version: 1,
      sender: { name: "Bridge" },
      tracking_data: "hub-bridge",
      type: "text",
      text,
    };
    if (media) {
      if (!c.publicBaseUrl)
        throw new RelayDeliveryError(
          "Chưa có HTTPS công khai để Viber tải file.",
          false,
        );
      const token = randomBytes(32).toString("hex"),
        name = safeRelayFilename(media.name);
      await query(
        "INSERT INTO bridge_media(token,payload_cipher,name,mime) VALUES($1,$2,$3,$4)",
        [token, encrypt(media.data.toString("base64")), name, media.mime],
      );
      const url =
        c.publicBaseUrl +
        "/relay-media/" +
        token +
        "/" +
        encodeURIComponent(name);
      const picture =
        media.kind === "image" &&
        ["image/jpeg", "image/png"].includes(media.mime) &&
        media.data.length <= 1024 * 1024;
      body = picture
        ? { ...body, type: "picture", media: url, text: text.slice(0, 768) }
        : {
            ...body,
            type: "file",
            media: url,
            size: media.data.length,
            file_name: name,
          };
    }
    const result = await this.viber("send_message", c, body);
    if (!result.message_token)
      throw new RelayDeliveryError("Viber chưa xác nhận ID tin.", true);
    return String(result.message_token);
  }
}
function snowflakeNow() {
  return ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
}
function labelsFor(p: string) {
  return p === "discord" ? "Discord" : p === "whatsapp" ? "WhatsApp" : "Viber";
}
