import { createHash, randomBytes } from "node:crypto";
import { query, setting, event } from "./db.js";
import { decrypt, encrypt } from "./security.js";

type TelegramConfig = {
  tokenEncrypted?: string;
  botUsername?: string;
  offset?: number;
  chatId?: string;
  chatName?: string;
  lastError?: string;
};

const codeHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramBridge {
  private polling = false;
  private api(token: string) {
    const call = async (method: string, body: Record<string, unknown> = {}) => {
      let response: Response;
      try {
        response = await fetch(
          `https://api.telegram.org/bot${token}/${method}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(
              (Number(body.timeout) || 0) * 1000 + 15000,
            ),
          },
        );
      } catch {
        throw new Error(`Không kết nối được Telegram (${method}).`);
      }
      let result: any;
      try {
        result = await response.json();
      } catch {
        throw new Error(`Telegram trả phản hồi không hợp lệ (${method}).`);
      }
      if (!response.ok || !result?.ok) {
        if (
          method === "getUpdates" &&
          /webhook/i.test(result?.description || "")
        )
          throw new Error(
            "Bot Telegram đang dùng webhook; hãy gỡ webhook trước khi bật polling.",
          );
        throw new Error(
          `Telegram từ chối ${method}: ${String(result?.description || response.statusText).slice(0, 180)}`,
        );
      }
      return result.result;
    };
    return {
      getMe: () => call("getMe"),
      getUpdates: (offset: number) =>
        call("getUpdates", {
          offset,
          timeout: 20,
          allowed_updates: ["message"],
        }),
      sendMessage: (chatId: string, text: string) =>
        call("sendMessage", {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
    };
  }
  private async config() {
    return (await setting<TelegramConfig>("telegram")) || {};
  }
  private async save(config: TelegramConfig) {
    await query(
      "INSERT INTO settings(key,value) VALUES('telegram',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [config],
    );
  }
  async state() {
    const config = await this.config();
    return {
      status: config.tokenEncrypted
        ? config.lastError
          ? "offline"
          : "connected"
        : "disconnected",
      botUsername: config.botUsername || null,
      tokenMasked: config.tokenEncrypted
        ? `${decrypt(config.tokenEncrypted).split(":")[0]}:•••••${decrypt(config.tokenEncrypted).slice(-3)}`
        : null,
      linked: Boolean(config.chatId),
      chatName: config.chatName || null,
      lastError: config.lastError || null,
    };
  }
  async configure(rawToken: string) {
    const token = rawToken.trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))
      throw Object.assign(
        new Error(
          "Token không đúng dạng. Tạo bot qua @BotFather rồi nhập lại.",
        ),
        { statusCode: 400 },
      );
    let me: any;
    try {
      me = await this.api(token).getMe();
    } catch (error: any) {
      throw Object.assign(
        new Error(
          error.message.startsWith("Không kết nối")
            ? error.message
            : "Telegram không nhận token này. Kiểm tra token lấy từ @BotFather.",
        ),
        { statusCode: error.message.startsWith("Không kết nối") ? 502 : 400 },
      );
    }
    const old = await this.config();
    const unchanged =
      old.tokenEncrypted && decrypt(old.tokenEncrypted) === token;
    await this.save({
      tokenEncrypted: encrypt(token),
      botUsername: String(me.username || ""),
      offset: unchanged ? old.offset || 0 : 0,
      chatId: unchanged ? old.chatId : undefined,
      chatName: unchanged ? old.chatName : undefined,
    });
    await event(
      "telegram",
      `Đã kết nối bot Telegram @${me.username || "unknown"}`,
    );
    return this.state();
  }
  async disconnect() {
    await this.save({});
    await query("DELETE FROM telegram_link_codes");
    await event("telegram", "Đã ngắt kết nối bot Telegram");
    return this.state();
  }
  async createLink() {
    const config = await this.config();
    if (!config.tokenEncrypted || !config.botUsername)
      throw Object.assign(new Error("Hãy kết nối bot Telegram trước."), {
        statusCode: 409,
      });
    const code = randomBytes(24).toString("base64url");
    await query(
      "DELETE FROM telegram_link_codes WHERE expires_at < now() OR used_at IS NOT NULL",
    );
    await query(
      "INSERT INTO telegram_link_codes(code_hash,expires_at) VALUES($1,now()+interval '10 minutes')",
      [codeHash(code)],
    );
    return {
      url: `https://t.me/${config.botUsername}?start=${code}`,
      expiresInSeconds: 600,
    };
  }
  async test() {
    const config = await this.config();
    if (!config.tokenEncrypted)
      throw Object.assign(new Error("Chưa kết nối bot Telegram."), {
        statusCode: 409,
      });
    if (!config.chatId)
      throw Object.assign(
        new Error("Hãy nối tài khoản Telegram của anh trước."),
        {
          statusCode: 409,
        },
      );
    try {
      await this.api(decrypt(config.tokenEncrypted)).sendMessage(
        config.chatId,
        "✅ Tin thử từ Zalo Agent Hub — kết nối Telegram đang hoạt động.",
      );
    } catch (error: any) {
      await this.save({ ...config, lastError: error.message });
      throw Object.assign(new Error("Không gửi được tin thử qua Telegram."), {
        statusCode: 502,
      });
    }
    await this.save({ ...config, lastError: undefined });
    return { ok: true };
  }
  async notify(text: string) {
    const config = await this.config();
    if (!config.tokenEncrypted || !config.chatId) return false;
    try {
      await this.api(decrypt(config.tokenEncrypted)).sendMessage(
        config.chatId,
        text.slice(0, 3900),
      );
      await this.save({ ...config, lastError: undefined });
      return true;
    } catch (error: any) {
      await this.save({ ...config, lastError: error.message });
      return false;
    }
  }
  async pollOnce() {
    if (this.polling) return;
    this.polling = true;
    try {
      const initial = await this.config();
      if (!initial.tokenEncrypted) {
        await delay(3000);
        return;
      }
      const token = decrypt(initial.tokenEncrypted);
      const updates = await this.api(token).getUpdates(initial.offset || 0);
      const current = await this.config();
      if (current.tokenEncrypted !== initial.tokenEncrypted) return;
      let offset = initial.offset || 0;
      for (const update of updates || []) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        const message = update.message;
        if (message?.chat?.type !== "private") continue;
        const match = /^\/start(?:@\w+)?\s+(\S+)/.exec(message.text || "");
        if (!match) continue;
        const linked = await query(
          "UPDATE telegram_link_codes SET used_at=now(),chat_id=$2 WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING code_hash",
          [codeHash(match[1]), String(message.chat.id)],
        );
        if (!linked.rowCount) continue;
        const name = [message.from?.first_name, message.from?.last_name]
          .filter(Boolean)
          .join(" ")
          .slice(0, 100);
        const updatedConfig = await this.config();
        if (updatedConfig.tokenEncrypted !== initial.tokenEncrypted) return;
        await this.save({
          ...updatedConfig,
          chatId: String(message.chat.id),
          chatName: name || message.from?.username || String(message.chat.id),
          lastError: undefined,
        });
        await this.api(token)
          .sendMessage(
            String(message.chat.id),
            "Đã nối Telegram với Zalo Agent Hub. Anh sẽ nhận cảnh báo kết nối tại đây.",
          )
          .catch(() => {});
        await event("telegram", "Đã liên kết tài khoản nhận cảnh báo Telegram");
      }
      const latest = await this.config();
      if (latest.tokenEncrypted === initial.tokenEncrypted)
        await this.save({ ...latest, offset, lastError: undefined });
    } catch (error: any) {
      const config = await this.config().catch(() => ({}) as TelegramConfig);
      if (config.tokenEncrypted)
        await this.save({
          ...config,
          lastError: String(error.message || "Telegram poll error").slice(
            0,
            200,
          ),
        }).catch(() => {});
      await delay(5000);
    } finally {
      this.polling = false;
    }
  }
}
