import {RelayDeliveryError,type RelayGroupCheck} from "./channel-relay.js";
import {telegramRelayEnvelope,type RelayEnvelope} from "./relay-input.js";
import {downloadRelayFile,RELAY_MAX_BYTES} from "./relay-media.js";
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
  lastPollAt?: string;
};

const receivingReady=(c:TelegramConfig)=>Boolean(c.tokenEncrypted&&!c.lastError&&c.lastPollAt&&Date.now()-Date.parse(c.lastPollAt)<90000);
const codeHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramBridge {
  onRelayMessage?: (message:RelayEnvelope)=>Promise<unknown>;
  async relayIdentity(){const config=await this.config();return{botId:config.tokenEncrypted?decrypt(config.tokenEncrypted).split(':')[0]:null,receiving:receivingReady(config)};}
  private async observeGroup(botId:string,chat:any,status?:string){if(!chat||!['group','supergroup'].includes(chat.type))return;await query('INSERT INTO telegram_relay_groups(bot_id,chat_id,title,chat_type,member_status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(bot_id,chat_id) DO UPDATE SET title=EXCLUDED.title,chat_type=EXCLUDED.chat_type,member_status=COALESCE(EXCLUDED.member_status,telegram_relay_groups.member_status),last_seen=now()',[botId,String(chat.id),String(chat.title||chat.id).slice(0,100),chat.type,status||null]);}
  async checkRelayGroup(chatId:string):Promise<RelayGroupCheck>{
    try{
    const cfg=await this.config();if(!cfg.tokenEncrypted)throw Object.assign(new Error('Chưa kết nối bot Telegram.'),{statusCode:409});
    const api=this.api(decrypt(cfg.tokenEncrypted)),me=await api.getMe(),chat=await api.getChat(chatId);if(!['group','supergroup'].includes(chat.type))throw Object.assign(new Error('Bridge chỉ hỗ trợ nhóm/supergroup Telegram, không dùng DM hoặc channel.'),{statusCode:409});
    const member=await api.getChatMember(chatId,String(me.id)),admin=['administrator','creator'].includes(member.status),joined=!['left','kicked'].includes(member.status);
    const permissions=member.status==='restricted'?member:chat.permissions||{};
    const result={botId:String(me.id),chatId:String(chat.id),title:String(chat.title||chat.id).slice(0,100),member:joined,canReadAll:joined&&(admin||me.can_read_all_group_messages===true),canSend:joined&&(admin||permissions.can_send_messages!==false),canSendMedia:joined&&(admin||(permissions.can_send_photos!==false&&permissions.can_send_documents!==false))};
    await this.observeGroup(result.botId,chat,member.status);await query('UPDATE telegram_relay_groups SET can_read_all=$3,can_send=$4,can_send_media=$5,checked_at=now() WHERE bot_id=$1 AND chat_id=$2',[result.botId,result.chatId,result.canReadAll,result.canSend,result.canSendMedia]);return result;
    }catch(error){if(error instanceof RelayDeliveryError)throw Object.assign(new Error(error.message),{statusCode:error.ambiguous?502:409});throw error;}
  }
  async relayFile(fileId:string){const cfg=await this.config();if(!cfg.tokenEncrypted)throw new Error('Chưa kết nối Telegram.');const token=decrypt(cfg.tokenEncrypted),file=await this.api(token).getFile(fileId);if(file.file_size>RELAY_MAX_BYTES)throw new Error('File vượt giới hạn Bridge 20 MB.');if(typeof file.file_path!=='string'||!/^[-a-zA-Z0-9_./]+$/.test(file.file_path)||file.file_path.split('/').includes('..'))throw new Error('Telegram chưa cấp đường dẫn tải file hợp lệ.');const loaded=await downloadRelayFile('https://api.telegram.org/file/bot'+token+'/'+file.file_path,'https://api.telegram.org');return{...loaded,name:file.file_path.split('/').at(-1)||'attachment.bin'};}
  async sendRelay(chatId:string,text:string,media?:{data:Buffer;name:string;mime:string;kind:'image'|'file'}){
    const cfg=await this.config();if(!cfg.tokenEncrypted)throw new RelayDeliveryError('Bot Telegram đã ngắt kết nối.',false);
    const api=this.api(decrypt(cfg.tokenEncrypted));const result=media?await api.sendMedia(chatId,text,media):await api.sendMessage(chatId,text);if(!Number.isSafeInteger(result?.message_id)||result.message_id<=0)throw new RelayDeliveryError('Telegram chưa xác nhận ID tin gửi.',true);return String(result.message_id);
  }

  private polling = false;
  private api(token: string) {
    const call = async (method: string, body: Record<string, unknown> = {},form?:FormData) => {
      let response: Response;
      try {
        response = await fetch(
          `https://api.telegram.org/bot${token}/${method}`,
          {
            method: "POST",
            ...(form?{body:form}:{headers:{"content-type":"application/json"},body:JSON.stringify(body)}),
            signal: AbortSignal.timeout(
              form?120000:(Number(body.timeout) || 0) * 1000 + 15000,
            ),
          },
        );
      } catch {
        throw new RelayDeliveryError(`Không kết nối được Telegram (${method}).`,true);
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
        throw new RelayDeliveryError(`Telegram từ chối ${method}: ${String(result?.description || response.statusText).slice(0,180)}`,response.status>=500||response.status===408,Number(result?.parameters?.retry_after)||undefined);
      }
      return result.result;
    };
    return {
      getMe: () => call("getMe"),
      getChat:(chatId:string)=>call('getChat',{chat_id:chatId}),
      getChatMember:(chatId:string,userId:string)=>call('getChatMember',{chat_id:chatId,user_id:userId}),
      getFile:(fileId:string)=>call('getFile',{file_id:fileId}),
      sendMedia:(chatId:string,text:string,media:{data:Buffer;name:string;mime:string;kind:'image'|'file'})=>{
        const photo=media.kind==='image'&&/image\/(jpeg|png)/i.test(media.mime)&&media.data.length<=10*1024*1024;
        const form=new FormData();form.set('chat_id',chatId);form.set('caption',text.slice(0,900));form.set(photo?'photo':'document',new Blob([new Uint8Array(media.data)],{type:media.mime}),media.name);return call(photo?'sendPhoto':'sendDocument',{},form);
      },
      getUpdates: (offset: number) =>
        call("getUpdates", {
          offset,
          timeout: 20,
          allowed_updates: ["message","my_chat_member"],
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
      receivingReady:receivingReady(config),
      lastPollAt:config.lastPollAt||null,
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
        const botId=token.split(':')[0];
        if(update.my_chat_member){await this.observeGroup(botId,update.my_chat_member.chat,update.my_chat_member.new_chat_member?.status);}
        const message = update.message;
        if(['group','supergroup'].includes(message?.chat?.type)){
          await this.observeGroup(botId,message.chat);
          const envelope=telegramRelayEnvelope(message,botId);if(envelope&&this.onRelayMessage)await this.onRelayMessage(envelope);
          continue;
        }
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
        await this.save({ ...latest, offset, lastError: undefined,lastPollAt:new Date().toISOString() });
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
