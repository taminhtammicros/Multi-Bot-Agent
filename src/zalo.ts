import { recordGroupMessage, sourceTime } from "./group-brain.js";
import { getChatProfile } from "./chat-profiles.js";
import { captureReplyTarget, formatReply } from "./zalo-replies.js";
import { splitMentioned, welcomeMessage, stripEmoji } from "./zalo-format.js";
import { createHash, randomUUID } from "node:crypto";
import { Reactions } from "zca-js";
import { replyMode, permitsReply, isBotMentioned } from "./reply-policy.js";
import { Zalo, LoginQRCallbackEventType, ThreadType, type API } from "zca-js";
import { readFile, rm } from "node:fs/promises";
import { encrypt, decrypt, privateFile } from "./security.js";
import { pool, query, event } from "./db.js";
import { getZaloPolicy } from "./zalo-policy.js";
import { enqueue } from "./engine.js";
import { ZaloRecovery, type RecoveryOptions } from "./zalo-recovery.js";
import { observeContact, observeGroup } from "./contacts.js";
type BridgeOptions = {
  recovery?: Partial<RecoveryOptions>;
  loadSession?: () => Promise<any>;
  saveSession?: (credentials: any) => Promise<void>;
  recordEvent?: (kind: string, message: string) => Promise<void>;
};
export class ZaloBridge {
  constructor(
    private readonly createClient: (
      signal?: AbortSignal,
    ) => Pick<Zalo, "login" | "loginQR"> = (signal) =>
      new Zalo({
        logging: false,
        checkUpdate: false,
        selfListen: true,
        polyfill: signal
          ? (input, init) =>
              fetch(input, {
                ...init,
                signal: AbortSignal.any([
                  signal,
                  AbortSignal.timeout(20000),
                  ...(init?.signal ? [init.signal] : []),
                ]),
              })
          : globalThis.fetch,
      }),
    private readonly qrStartupTimeoutMs = 20000,
    private readonly options: BridgeOptions = {},
  ) {
    this.recovery = new ZaloRecovery(
      async (current) => {
        this.retire();
        this.sessionController = new AbortController();
        const api = await this.createClient(
          this.sessionController.signal,
        ).login(this.credentials);
        if (!current()) {
          api.listener.stop();
          return;
        }
        await this.attach(api);
        if (!current() && this.api !== api) {
          api.listener.stop();
          return;
        }
        // Persist refreshed cookies when the installed SDK exposes its context.
        if (typeof api.getContext === "function" && this.api === api) {
          const ctx = api.getContext();
          const cookies = ctx.cookie?.toJSON()?.cookies;
          if (cookies && ctx.imei && ctx.userAgent) {
            this.credentials = {
              cookie: cookies,
              imei: ctx.imei,
              userAgent: ctx.userAgent,
            };
            await this.saveSession(this.credentials).catch(() => {});
          }
        }
      },
      () => this.retire(),
      (message) => {
        this.status =
          this.recovery.state.conflict || this.recovery.state.requiresLogin
            ? "disconnected"
            : "connecting";
        this.error = message;
        void this.recordEvent("zalo_recovery", message).catch(() => {});
      },
      options.recovery,
    );
  }
  readonly recovery: ZaloRecovery;
  private credentials: any;
  private sessionController?: AbortController;
  private saving: Promise<void> = Promise.resolve();
  private cachedAccountId: string | null = null;
  private recordEvent(kind: string, message: string) {
    return this.options.recordEvent
      ? this.options.recordEvent(kind, message)
      : event(kind, message);
  }
  private saveSession(credentials: any) {
    this.saving = this.saving
      .catch(() => {})
      .then(() =>
        this.options.saveSession
          ? this.options.saveSession(credentials)
          : privateFile(
              "data/zalo-session",
              encrypt(JSON.stringify(credentials)),
            ),
      );
    return this.saving;
  }
  private retire() {
    this.sessionController?.abort();
    this.sessionController = undefined;
    const old = this.api;
    this.api = undefined;
    old?.listener.stop();
  }
  shutdown() {
    ++this.generation;
    this.recovery.stop();
    this.pending = false;
    this.abort?.();
    this.abort = undefined;
    this.retire();
  }
  async reconnect() {
    if (this.status === "connected") return;
    if (this.pending) return;
    if (!this.credentials) {
      await this.restore();
      return;
    }
    if (this.recovery.state.requiresLogin) return;
    this.recovery.enable();
    await this.recovery.retryNow();
  }
  api?: API;
  status = "disconnected";
  qr: string | null = null;
  error: string | null = null;
  generation = 0;
  pending = false;
  abort?: () => unknown;
  diagnostics = {
    received: 0,
    accepted: 0,
    blocked: 0,
    unsupported: 0,
    self: 0,
    duplicates: 0,
    lastReceivedAt: null as string | null,
    lastSenderId: null as string | null,
    lastThreadId: null as string | null,
    lastDecision: null as string | null,
    lastError: null as string | null,
  };
  state() {
    return {
      status: this.status,
      qr: this.qr,
      error: this.error,
      accountId: this.api?.getOwnId() || this.cachedAccountId,
      loginPending: this.pending,
      recovery: { ...this.recovery.state, hasSession: !!this.credentials },
      diagnostics: this.diagnostics,
    };
  }
  async restore() {
    const generation = this.generation;
    try {
      const credentials = this.options.loadSession
        ? await this.options.loadSession()
        : JSON.parse(decrypt(await readFile("data/zalo-session", "utf8")));
      if (generation !== this.generation) return;
      this.credentials = credentials;
      this.recovery.enable();
      await this.recovery.retryNow();
    } catch (error: any) {
      if (generation !== this.generation) return;
      this.status = "disconnected";
      if (error.code !== "ENOENT") {
        this.recovery.stop();
        this.recovery.state.requiresLogin = true;
        this.error =
          "Không đọc được phiên Zalo đã lưu. Hãy đăng nhập lại bằng QR.";
      }
    }
  }
  start() {
    if (this.pending || this.status === "connected") return;
    // Explicit QR login takes ownership from any pending session recovery.
    this.recovery.stop();
    this.retire();
    this.pending = true;
    this.status = "connecting";
    this.qr = null;
    this.error = null;
    const gen = ++this.generation;
    let credentials: any;
    const current = () => gen === this.generation;
    const fail = (message: string) => {
      if (!current()) return;
      ++this.generation;
      this.pending = false;
      this.status = "disconnected";
      this.qr = null;
      this.error = message;
      clearTimeout(timeout);
      this.abort?.();
      this.abort = undefined;
    };
    const timeout = setTimeout(
      () =>
        fail("Zalo chưa trả mã QR sau 20 giây. Kiểm tra mạng và bấm Thử lại."),
      this.qrStartupTimeoutMs,
    );
    timeout.unref();
    this.abort = undefined;
    // Promise.resolve also catches synchronous client errors.
    Promise.resolve()
      .then(() =>
        this.createClient().loginQR(undefined, (evt) => {
          if (!current()) {
            evt.actions?.abort();
            return;
          }
          if (evt.actions) this.abort = () => evt.actions?.abort();
          switch (evt.type) {
            case LoginQRCallbackEventType.QRCodeGenerated:
              clearTimeout(timeout);
              this.qr = evt.data.image.startsWith("data:")
                ? evt.data.image
                : `data:image/png;base64,${evt.data.image}`;
              this.status = "qr";
              break;
            case LoginQRCallbackEventType.QRCodeScanned:
              this.status = "scanned";
              break;
            case LoginQRCallbackEventType.GotLoginInfo:
              credentials = evt.data;
              break;
            case LoginQRCallbackEventType.QRCodeExpired:
              fail("Mã QR đã hết hạn. Bấm Thử lại để tạo mã mới.");
              break;
            case LoginQRCallbackEventType.QRCodeDeclined:
              fail(
                "Đăng nhập bị từ chối trên điện thoại. Bấm Thử lại để tạo mã mới.",
              );
              break;
          }
        }),
      )
      .then(async (api) => {
        if (!current()) {
          api.listener.stop();
          return;
        }
        clearTimeout(timeout);
        if (credentials) {
          this.credentials = credentials;
          await this.saveSession(credentials);
        }
        if (!current()) {
          api.listener.stop();
          return;
        }
        this.recovery.enable();
        this.recovery.watchConnection();
        await this.attach(api);
      })
      .catch(() =>
        fail(
          "Không thể đăng nhập Zalo. Kiểm tra kết nối mạng rồi bấm Thử lại.",
        ),
      )
      .finally(() => {
        clearTimeout(timeout);
        if (current()) {
          this.pending = false;
          this.abort = undefined;
        }
      });
  }
  async attach(api: API) {
    this.api = api;
    this.qr = null;
    this.status = "connecting";
    this.cachedAccountId = String(api.getOwnId());
    api.listener.on("connected", () => {
      if (this.api !== api) return;
      this.recovery.connected();
      this.status = "connected";
      this.error = null;
      void this.syncGroups().catch(() => {
        void this.recordEvent(
          "zalo_groups",
          "Không đồng bộ được nhóm. Có thể thử lại trên dashboard.",
        ).catch(() => {});
      });
      void this.recordEvent(
        "zalo_connection",
        "Zalo đã kết nối; bộ giám sát đang hoạt động.",
      ).catch(() => {});
    });
    const disconnected = (code: number) => {
      if (this.api !== api) return;
      this.retire();
      this.recovery.disconnected(code);
    };
    api.listener.on("disconnected", disconnected);
    api.listener.on("closed", disconnected);
    api.listener.on("error", (error) => {
      if (this.api !== api) return;
      // SDK emits decoding errors here too; only close events mark a disconnect.
      const name = error instanceof Error ? error.name : "ListenerError";
      this.diagnostics.lastError = "Zalo listener: " + name;
      void event("zalo_error", "Zalo listener: " + name).catch(() => {});
    });
    api.listener.on("message", (m) => {
      if (this.api !== api) return;
      void this.receive(m).catch((error: unknown) => {
        this.error = "Không lưu được tin nhắn. Kiểm tra database.";
        const code =
          typeof (error as any)?.code === "string"
            ? (error as any).code
            : "unknown";
        this.diagnostics.lastDecision = "storage_error";
        this.diagnostics.lastError = "Lỗi lưu tin nhắn (" + code + ")";
        void event("zalo_error", "Lỗi tiếp nhận tin Zalo: " + code).catch(
          () => {},
        );
      });
    });
    api.listener.on("group_event", (evt) => {
      if (this.api !== api) return;
      void this.queueWelcome(evt, api).catch(() => {
        void this.recordEvent(
          "zalo_welcome",
          "Không thể tạo lời chào nhóm.",
        ).catch(() => {});
      });
      const data = evt.data as any,
        id = String(data.groupId || evt.threadId || "");
      void observeGroup(
        String(api.getOwnId()),
        id,
        typeof data.groupName === "string" ? data.groupName : "",
      )
        .then(() =>
          this.recordEvent("zalo_group_event", `Nhóm ${id}: ${evt.type}`),
        )
        .catch(() => {});
    });
    api.listener.start({ retryOnClose: false });
    await this.recordEvent("zalo", "Đã khởi tạo listener Zalo").catch(() => {});
  }
  private groupsSync?: Promise<number>;
  syncGroups() {
    if (this.groupsSync) return this.groupsSync;
    const api = this.api;
    if (!api || this.status !== "connected")
      return Promise.reject(
        Object.assign(new Error("Zalo chưa kết nối"), { statusCode: 409 }),
      );
    if (typeof api.getAllGroups !== "function") return Promise.resolve(0);
    const accountId = String(api.getOwnId());
    this.groupsSync = (async () => {
      const all = await api.getAllGroups();
      const ids = Object.keys(all.gridVerMap || {}).filter((id) =>
        /^\d{1,30}$/.test(id),
      );
      let count = 0;
      for (let i = 0; i < ids.length; i += 20) {
        if (this.api !== api)
          throw Object.assign(
            new Error("Phiên Zalo đã thay đổi trong lúc đồng bộ"),
            { statusCode: 409 },
          );
        const batch = ids.slice(i, i + 20);
        const info = await api.getGroupInfo(batch);
        if (this.api !== api)
          throw Object.assign(
            new Error("Phiên Zalo đã thay đổi trong lúc đồng bộ"),
            { statusCode: 409 },
          );
        for (const id of batch) {
          const group = info.gridInfoMap?.[id];
          await observeGroup(
            accountId,
            id,
            group?.name || "",
            false,
            group?.totalMember,
          );
          count++;
        }
      }
      await this.recordEvent(
        "zalo_groups",
        `Đã đồng bộ ${count} nhóm; không thay đổi quyền truy cập.`,
      );
      return count;
    })().finally(() => {
      this.groupsSync = undefined;
    });
    return this.groupsSync;
  }
  async queueWelcome(evt: any, api: API) {
    if (evt.type !== "join" || this.api !== api) return;
    const accountId = String(api.getOwnId()),
      data = evt.data || {},
      groupId = String(data.groupId || evt.threadId || "");
    if (!/^\d{1,30}$/.test(groupId) || !data.time) return;
    const members = (
      Array.isArray(data.updateMembers) ? data.updateMembers : []
    )
      .filter((m: any) => String(m.id) !== accountId)
      .map((m: any) => ({ id: String(m.id), dName: String(m.dName || m.id) }));
    if (!members.length) return;
    const p = await getChatProfile(accountId, "group", groupId);
    if (
      !p.welcome.trim() ||
      (await replyMode(accountId, "group", groupId)) === "silent"
    )
      return;
    const greeting = welcomeMessage(
      p.emoji ? p.welcome : stripEmoji(p.welcome),
      members,
      String(data.groupName || ""),
    );
    const parts = splitMentioned(greeting);
    const eventKey = createHash("sha256")
      .update(
        [
          accountId,
          groupId,
          String(data.time),
          members
            .map((m: any) => m.id)
            .sort()
            .join(","),
        ].join(":"),
      )
      .digest("hex");
    for (const [index, part] of parts.entries())
      await query(
        "INSERT INTO zalo_announcements(id,account_id,group_id,event_key,content,mentions) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO NOTHING",
        [
          randomUUID(),
          accountId,
          groupId,
          eventKey + ":" + index,
          part.msg,
          JSON.stringify(part.mentions),
        ],
      );
  }
  async flushAnnouncements() {
    if (!this.api || this.status !== "connected") return;
    const api = this.api,
      accountId = String(api.getOwnId());
    const rows = (
      await query(
        "SELECT * FROM zalo_announcements WHERE account_id=$1 AND status='pending' ORDER BY created_at LIMIT 10",
        [accountId],
      )
    ).rows;
    for (const row of rows) {
      const p = await getChatProfile(accountId, "group", row.group_id);
      if (
        !p.welcome.trim() ||
        (await replyMode(accountId, "group", row.group_id)) === "silent"
      ) {
        await query(
          "UPDATE zalo_announcements SET status='cancelled',error='Lời chào đã tắt hoặc nhóm đang im lặng.' WHERE id=$1",
          [row.id],
        );
        continue;
      }
      await query(
        "UPDATE zalo_announcements SET status='sending' WHERE id=$1",
        [row.id],
      );
      try {
        await api.sendMessage(
          { msg: row.content, mentions: row.mentions },
          row.group_id,
          ThreadType.Group,
        );
        await query(
          "UPDATE zalo_announcements SET status='sent',error=null WHERE id=$1",
          [row.id],
        );
      } catch {
        await query(
          "UPDATE zalo_announcements SET status='review',error='Không xác định lời chào đã được gửi; không tự gửi lại.' WHERE id=$1",
          [row.id],
        );
      }
    }
  }
  async receive(m: any) {
    const diag = this.diagnostics;
    diag.received++;
    diag.lastReceivedAt = new Date().toISOString();
    diag.lastSenderId = m.data?.uidFrom == null ? null : String(m.data.uidFrom);
    diag.lastThreadId = m.threadId == null ? null : String(m.threadId);
    diag.lastError = null;
    if (m.isSelf) {
      diag.self++;
      diag.lastDecision = "self";
      return;
    }
    if (m.type === ThreadType.User && this.api) {
      await observeContact(
        String(this.api.getOwnId()),
        String(m.data?.uidFrom || ""),
        typeof m.data?.dName === "string" ? m.data.dName : "",
      );
    }
    if (m.type === ThreadType.Group && this.api) {
      await observeGroup(
        String(this.api.getOwnId()),
        String(m.threadId),
        "",
        true,
      );
    }
    const cfg = await getZaloPolicy(
      this.api ? String(this.api.getOwnId()) : null,
    ),
      group = m.type === ThreadType.Group;
    const allowed = group
      ? cfg.groupsEnabled && cfg.allowGroups.includes(String(m.threadId))
      : cfg.allowUsers.includes(String(m.data.uidFrom));
    if (!allowed) {
      diag.blocked++;
      diag.lastDecision = "not_allowed";
      await event(
        "zalo_access",
        `Bỏ qua ${group ? "nhóm" : "DM"}: sender=${String(m.data.uidFrom)}, thread=${String(m.threadId)} chưa được cho phép`,
      );
      return;
    }
    const accountId = this.state().accountId;
    const mentioned = isBotMentioned(m, accountId);
    const mode = await replyMode(
      accountId,
      group ? "group" : "dm",
      String(m.threadId),
      cfg,
    );
    const shouldReply = permitsReply(mode, mentioned);
    if (group && accountId && mode !== "silent") {
      const profile = await getChatProfile(
        accountId,
        "group",
        String(m.threadId),
      );
      if (profile.groupMemoryEnabled || shouldReply) {
        const text =
          typeof m.data?.content === "string"
            ? m.data.content
            : "[Nội dung đính kèm chưa được đọc; không suy đoán nội dung]";
        if (!m.data?.msgId) throw new Error("Tin nhóm thiếu ID nguồn.");
        await recordGroupMessage(
          { accountId, groupId: String(m.threadId) },
          {
            externalId: String(m.data.msgId),
            senderId: String(m.data.uidFrom),
            senderName: String(m.data.dName || m.data.uidFrom),
            content: text,
            occurredAt: sourceTime(m.data.ts),
            replyExternalId:
              typeof m.data.quote?.globalMsgId === "string" ||
              Number.isSafeInteger(m.data.quote?.globalMsgId)
                ? String(m.data.quote.globalMsgId)
                : null,
            replyExcerpt:
              typeof m.data.quote?.msg === "string" ? m.data.quote.msg : null,
            replySenderId: m.data.quote?.ownerId
              ? String(m.data.quote.ownerId)
              : null,
            role: typeof m.data?.content === "string" ? "user" : "unsupported",
          },
        );
      }
    }
    if (typeof m.data?.content !== "string") {
      diag.unsupported++;
      diag.lastDecision = "unsupported_content";
      return;
    }
    if (!shouldReply) {
      diag.blocked++;
      diag.lastDecision = mode === "mention" ? "listening" : "silent";
      return;
    }
    const groupTitle =
      group && this.api
        ? (
            await query(
              "SELECT display_name FROM zalo_groups WHERE account_id=$1 AND group_id=$2",
              [String(this.api.getOwnId()), String(m.threadId)],
            )
          ).rows[0]?.display_name
        : null;
    const task = await enqueue(
      `zalo:${m.type}:${m.threadId}`,
      group
        ? groupTitle || "Nhóm " + String(m.threadId)
        : String(m.data.dName || m.threadId),
      "zalo",
      m.data.content,
      group
        ? `zalo:${accountId}:group:${m.threadId}:${m.data.msgId}`
        : `zalo:${m.type}:${m.threadId}:${m.data.msgId}`,
      String(m.threadId),
      m.type,
      {
        botMentioned: mentioned,
        sourceAccountId: accountId || undefined,
        zaloReply: captureReplyTarget(m.data),
      },
    );
    if (task) {
      diag.accepted++;
      diag.lastDecision = "queued";
      if (this.api && typeof this.api.addReaction === "function") {
        const p = await getChatProfile(
          accountId,
          group ? "group" : "dm",
          String(m.threadId),
        );
        if (p.emoji && m.data.msgId && m.data.cliMsgId) {
          void this.api
            .addReaction(Reactions.LIKE, {
              data: {
                msgId: String(m.data.msgId),
                cliMsgId: String(m.data.cliMsgId),
              },
              threadId: String(m.threadId),
              type: m.type,
            })
            .catch(() => {
              void this.recordEvent(
                "zalo_emoji",
                "Không thả được reaction cho tin đã nhận.",
              ).catch(() => {});
            });
        }
      }
      await event(
        "zalo_inbound",
        `Đã nhận ${group ? "nhóm" : "DM"} từ ${String(m.data.uidFrom)} → công việc ${task.slice(0, 8)}`,
      );
    } else {
      diag.duplicates++;
      diag.lastDecision = "duplicate";
    }
  }
  async disconnect() {
    this.shutdown();
    this.credentials = undefined;
    this.cachedAccountId = null;
    this.status = "disconnected";
    this.qr = null;
    this.error = null;
    await this.saving.catch(() => {});
    await rm("data/zalo-session", { force: true });
    await this.recordEvent("zalo", "Đã ngắt Zalo và xóa phiên lưu");
  }
  private async finishOwnerGroupSend(
    row: any,
    status: "sent" | "review" | "cancelled",
    detail: string,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const changed = await client.query(
        "UPDATE owner_group_sends SET status=$2,error=$3,updated_at=now(),sent_at=CASE WHEN $2='sent' THEN now() ELSE sent_at END WHERE id=$1 AND status='sending' RETURNING id",
        [row.id, status, status === "sent" ? null : detail],
      );
      if (!changed.rowCount) {
        await client.query("ROLLBACK");
        return;
      }
      const ownerStatus = status === "sent" ? "completed" : "review";
      const receipt =
        status === "sent"
          ? `Zalo đã nhận lệnh gửi vào nhóm ${row.group_id}. Nội dung: ${row.content}`
          : `Chưa xác nhận được tin đã vào nhóm ${row.group_id}. ${detail} Em không tự gửi lại; hãy kiểm tra nhóm trước khi thử lần nữa.`;
      await client.query(
        "UPDATE owner_actions SET status=$2,result=$3,updated_at=now() WHERE id=$1 AND status='executing'",
        [row.owner_action_id, ownerStatus, receipt],
      );
      const messageId = randomUUID();
      await client.query(
        "INSERT INTO messages(id,conversation_id,role,content,agent) VALUES($1,$2,'assistant',$3,'hub')",
        [messageId, row.conversation_id, receipt],
      );
      await client.query(
        "INSERT INTO outbox(id,task_id,conversation_id,content,kind) VALUES($1,$2,$3,$4,'owner_receipt') ON CONFLICT(task_id,kind) DO NOTHING",
        [randomUUID(), row.task_id, row.conversation_id, receipt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await event(
      "owner_send",
      `Owner-approved Zalo group send ${status} for ${row.group_id}`,
    );
  }
  private async flushOwnerGroupSends() {
    if (!this.api || this.status !== "connected") return;
    const api = this.api;
    const rows = (
      await query(
        "SELECT * FROM owner_group_sends WHERE status='pending' ORDER BY created_at LIMIT 10",
      )
    ).rows;
    for (const row of rows) {
      const claimed = await query(
        "UPDATE owner_group_sends SET status='sending',updated_at=now() WHERE id=$1 AND status='pending' RETURNING id",
        [row.id],
      );
      if (!claimed.rowCount) continue;
      const accountId = String(api.getOwnId());
      const policy = await getZaloPolicy(accountId);
      const isAllowed =
        row.account_id === accountId &&
        policy.groupsEnabled &&
        policy.allowGroups.includes(String(row.group_id)) &&
        !!(
          await query(
            "SELECT 1 FROM zalo_groups WHERE account_id=$1 AND group_id=$2",
            [accountId, row.group_id],
          )
        ).rowCount &&
        (await replyMode(accountId, "group", String(row.group_id), policy)) !==
          "silent";
      if (!isAllowed) {
        await this.finishOwnerGroupSend(
          row,
          "cancelled",
          "Tài khoản, quyền nhóm hoặc chế độ trả lời không còn cho phép gửi.",
        );
        continue;
      }
      try {
        await api.sendMessage(
          { msg: row.content },
          row.group_id,
          ThreadType.Group,
        );
        await this.finishOwnerGroupSend(
          row,
          "sent",
          "Zalo API đã nhận yêu cầu gửi.",
        );
      } catch {
        await this.finishOwnerGroupSend(
          row,
          "review",
          "Gửi bị gián đoạn; trạng thái phía Zalo chưa rõ.",
        );
      }
    }
  }
  async flush() {
    await this.flushAnnouncements();
    await this.flushOwnerGroupSends();
    const rows = (
      await query(
        "SELECT o.*,c.source,c.thread_id,c.thread_type,m.bot_mentioned,m.source_account_id,m.zalo_reply,m.content AS original_content FROM outbox o JOIN conversations c ON c.id=o.conversation_id JOIN tasks t ON t.id=o.task_id JOIN messages m ON m.id=t.message_id WHERE o.status='pending' ORDER BY o.created_at,o.id LIMIT 10",
      )
    ).rows;
    for (const item of rows) {
      if (item.source !== "zalo") {
        await query("UPDATE outbox SET status='sent' WHERE id=$1", [item.id]);
        continue;
      }
      if (this.status !== "connected" || !this.api) return;
      const policy = await getZaloPolicy(String(this.api.getOwnId()));
      const allowed =
        item.thread_type === ThreadType.Group
          ? policy.groupsEnabled &&
            policy.allowGroups.includes(String(item.thread_id))
          : policy.allowUsers.includes(String(item.thread_id));
      if (!allowed) {
        await query(
          "UPDATE outbox SET status='cancelled',error='Quyền truy cập đã bị thu hồi trước khi gửi phản hồi.' WHERE id=$1",
          [item.id],
        );
        continue;
      }
      if (
        (item.source_account_id &&
          item.source_account_id !== String(this.api.getOwnId())) ||
        !permitsReply(
          await replyMode(
            String(this.api.getOwnId()),
            item.thread_type === ThreadType.Group ? "group" : "dm",
            String(item.thread_id),
            policy,
          ),
          item.bot_mentioned,
        )
      ) {
        await query(
          "UPDATE outbox SET status='cancelled',error='Chế độ trả lời hiện tại không cho phép gửi phản hồi này.' WHERE id=$1",
          [item.id],
        );
        continue;
      }
      await query("UPDATE outbox SET status='sending' WHERE id=$1", [item.id]);
      try {
        const profile = await getChatProfile(
          String(this.api.getOwnId()),
          item.thread_type === ThreadType.Group ? "group" : "dm",
          String(item.thread_id),
        );
        const chunks = formatReply(
          item.content,
          profile,
          item.zalo_reply,
          item.original_content,
          item.thread_type === ThreadType.Group,
        );
        for (const chunk of chunks)
          await this.api.sendMessage(chunk, item.thread_id, item.thread_type);
        await query("UPDATE outbox SET status='sent',error=null WHERE id=$1", [
          item.id,
        ]);
      } catch {
        await query(
          "UPDATE outbox SET status='review',error='Gửi bị gián đoạn, cần kiểm tra Zalo trước khi gửi lại.' WHERE id=$1",
          [item.id],
        );
      }
    }
  }
}
