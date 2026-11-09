import { teamsDomSnapshot } from "./teams-dom.js";
import {
  callTeamsMac,
  teamsMacState,
  teamsMacMessages,
} from "./teams-mac-client.js";
import { decrypt } from "./security.js";
import { mkdir, chmod, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page, type Browser } from "playwright";
import { z } from "zod";
import { query } from "./db.js";
import { RelayDeliveryError } from "./channel-relay.js";
import { clean, conflict, type NetworkEnvelope } from "./bridge-types.js";
export function teamsChatUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw conflict("Nhập URL cuộc trò chuyện Teams Personal.");
  }
  if (
    u.protocol !== "https:" ||
    u.hostname !== "teams.live.com" ||
    u.username ||
    u.password ||
    u.port ||
    !u.pathname.startsWith("/v2")
  )
    throw conflict(
      "Chỉ nhận URL https://teams.live.com/v2/ của Teams Personal.",
    );
  return u.href;
}
// Fail closed when Teams changes its DOM or stops exposing a stable message ID/time/author.
export async function readTeamsMessages(page: Page) {
  return (await page.evaluate(teamsDomSnapshot)).rows;
}

export class TeamsPersonal {
  private context?: BrowserContext;
  private attachedBrowser?: Browser;
  private externalBrowser=false;
  async attachVpsBrave(){
    if(this.externalBrowser&&this.context)return this.browserState();
    let endpoint: string;
    if (process.env.TEAMS_CDP_ENDPOINT) {
      let base: URL;
      try { base = new URL(process.env.TEAMS_CDP_ENDPOINT); }
      catch { throw conflict('TEAMS_CDP_ENDPOINT không phải URL hợp lệ.'); }
      if (
        !['http:', 'https:'].includes(base.protocol) ||
        !['127.0.0.1', 'localhost', '::1'].includes(base.hostname) ||
        !base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash
      ) throw conflict('Teams CDP endpoint phải là địa chỉ loopback HTTP/HTTPS kèm port, ví dụ http://127.0.0.1:9222.');
      let version: any;
      try {
        const response = await fetch(new URL('/json/version', base), { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('status');
        version = await response.json();
      } catch {
        throw conflict('Không truy cập được Teams CDP endpoint. Kiểm tra SSH tunnel và TEAMS_CDP_ENDPOINT.');
      }
      let ws: URL;
      try { ws = new URL(version.webSocketDebuggerUrl); }
      catch { throw conflict('Brave không trả WebSocket CDP hợp lệ.'); }
      if (!['ws:', 'wss:'].includes(ws.protocol) || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(ws.pathname))
        throw conflict('Brave trả WebSocket CDP không hợp lệ.');
      ws.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      ws.hostname = base.hostname;
      ws.port = base.port;
      endpoint = ws.href;
    } else {
      const raw=await readFile('/home/ubuntu/.config/BraveSoftware/Brave-Browser/DevToolsActivePort','utf8').catch(()=>{throw conflict('Đặt TEAMS_CDP_ENDPOINT và mở SSH tunnel từ local tới Brave VPS, hoặc chạy Hub trên cùng VPS.');});
      const [port,path]=raw.trim().split(/\r?\n/);
      if(!/^\d{2,5}$/.test(port)||Number(port)<1024||Number(port)>65535||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path))throw conflict('Brave chưa cung cấp địa chỉ kết nối hợp lệ.');
      endpoint='ws://127.0.0.1:'+port+path;
    }
    let attached:Browser;
    try{attached=await chromium.connectOverCDP(endpoint,{timeout:90000});}
    catch{throw conflict('Chưa được Brave VPS cho phép kết nối. Anh bấm Allow trong hộp thoại Brave rồi kết nối lại.');}
    const context=attached.contexts()[0];if(!context){await attached.close();throw conflict('Không tìm thấy phiên Brave VPS.');}
    if(this.context&&!this.externalBrowser)await this.context.close().catch(()=>{});
    this.attachedBrowser=attached;this.externalBrowser=true;this.context=context;this.pages.clear();
    this.consolePage=context.pages().find(p=>new URL(p.url()).hostname==='teams.live.com');
    attached.on('disconnected',()=>{if(this.attachedBrowser===attached){this.context=undefined;this.consolePage=undefined;this.attachedBrowser=undefined;this.externalBrowser=false;this.pages.clear();}});
    return this.browserState();
  }
  private consolePage?: Page;
  private pages = new Map<string, Page>();
  private lastError: string | null = null;
  private opening?: Promise<void>;
  private busy = false;
  private ownReceipts = new Set<string>();
  onMessage?: (e: NetworkEnvelope) => Promise<unknown>;
  state() {
    return {
      open: !!this.context,
      error: this.lastError,
      experimental: true,
      mode: "personal",
      mediaSupported: false,
    };
  }
  async open() {
    if (this.context) return this.state();
    if (this.opening) {
      await this.opening;
      return this.state();
    }
    this.opening = (async () => {
      const dir = resolve("data/teams-personal-browser");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      try {
        this.context = await chromium.launchPersistentContext(dir, {
          executablePath:
            process.env.TEAMS_BROWSER_EXECUTABLE || "/usr/bin/brave-browser",
          headless: true,
          viewport: { width: 1200, height: 800 },
          acceptDownloads: false,
          args: ["--disable-dev-shm-usage"],
        });
        this.context.on("close", () => {
          this.context = undefined;
          this.consolePage = undefined;
          this.pages.clear();
        });
        this.consolePage =
          this.context.pages()[0] || (await this.context.newPage());
        await this.consolePage.goto("https://teams.live.com/v2/", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        // Teams is an SPA; DOMContentLoaded can precede the login controls by several seconds.
        await this.consolePage
          .waitForFunction(
            () =>
              Boolean(
                document.body?.innerText.trim().length > 30 ||
                document.querySelector(
                  'input[type="email"], input[type="password"]',
                ),
              ),
            undefined,
            { timeout: 30000 },
          )
          .catch(() => {});
        this.lastError = null;
      } catch {
        await this.context?.close().catch(() => {});
        this.context = undefined;
        this.lastError =
          "Không mở được Teams Personal Web. Kiểm tra trình duyệt trên VPS.";
        throw conflict(this.lastError);
      }
    })();
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
    return this.state();
  }
  private async console() {
    if (!this.context || !this.consolePage)
      throw conflict("Bấm Mở Teams Personal trước.");
    // Microsoft sign-in can open another tab; follow the authenticated Personal tab.
    const pages=this.context.pages().filter(p=>!p.isClosed());
    for(const candidate of [...pages].reverse()){
      if(new URL(candidate.url()).hostname==='teams.live.com'&&await candidate.locator('[data-tid="me-control-avatar-trigger"]').count()){
        this.consolePage=candidate;return candidate;
      }
    }
    const login=[...pages].reverse().find(p=>['login.live.com','account.live.com','login.microsoftonline.com','login.microsoft.com'].includes(new URL(p.url()).hostname));
    if(login)this.consolePage=login;
    return this.consolePage;
  }
  async browserState(){
    if (!this.context || !this.consolePage)
      return {open:false,mode:'vps_browser',authenticated:false,accountId:null,selfName:null,title:null,chatId:null,composerReady:false,messageCount:0};
    const p=await this.console();
    if(new URL(p.url()).hostname!=='teams.live.com')return {open:true,mode:'vps_browser',authenticated:false,host:new URL(p.url()).hostname};
    const s=await p.evaluate(teamsDomSnapshot);
    return {open:true,mode:'vps_browser',authenticated:!!s.accountId,accountId:s.accountId,selfName:s.selfName,title:s.title,chatId:s.chatId,composerReady:s.composerReady,messageCount:s.rows.length};
  }
  private directoryRefresh?: Promise<any>;
  async refreshDirectory() {
    if (this.directoryRefresh) return this.directoryRefresh;
    if (this.busy) throw conflict('Teams đang xử lý tin. Chờ vài giây rồi tải lại danh sách.');
    this.directoryRefresh = this.scanDirectory();
    try { return await this.directoryRefresh; }
    finally { this.directoryRefresh = undefined; }
  }
  private async scanDirectory() {
    this.busy = true;
    try {
      const page = await this.console();
      if (new URL(page.url()).hostname !== 'teams.live.com') throw conflict('Teams chưa đăng nhập.');
      return await page.evaluate(async () => {
        const helpers = { identity() { return document.querySelector('[data-tid="me-control-avatar-trigger"]')?.getAttribute('aria-label')?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || ''; } };
        const accountId = helpers.identity();
        if (!accountId) throw new Error('Không xác định được tài khoản Teams.');
        const selector = '[id^="title-chat-list-item_"]';
        const first = document.querySelector(selector);
        if (!first) throw new Error('Chưa thấy danh sách chat. Mở mục Chat trong Teams rồi tải lại.');
        let scroller: HTMLElement | null = first.parentElement;
        while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
        if (scroller === document.body || scroller === document.documentElement) scroller = null;
        const original = scroller?.scrollTop || 0;
        const chats = new Map<string, {chatId:string;title:string;kind:string}>();
        let complete = !scroller;
        const collector = { collect() {
          for (const node of document.querySelectorAll<HTMLElement>(selector)) {
            const chatId = node.id.slice('title-chat-list-item_'.length);
            const title = node.innerText.trim();
            const row = node.closest('[role="treeitem"]');
            const type = row?.getAttribute('data-fui-tree-item-value') || '';
            const kind = type.includes('OneGQL_GroupChatConversation|') ? 'group' : type.includes('OneGQL_OneOnOneChatConversation|') ? 'dm' : type.includes('OneGQL_SelfChatConversation|') ? 'self' : type.includes('OneGQL_MeetingChatConversation|') ? 'meeting' : 'unknown';
            if (chatId && title && chats.size < 2000) chats.set(chatId, {chatId,title,kind});
          }
        } };
        const deadline = Date.now() + 20000;
        try {
          collector.collect();
          if (scroller) {
            scroller.scrollTop = 0;
            for (let step = 0; step < 80 && Date.now() < deadline; step++) {
              await new Promise(resolve => setTimeout(resolve, 180));
              if (helpers.identity() !== accountId) throw new Error('Tài khoản Teams thay đổi khi đang tải.');
              collector.collect();
              if (!scroller.isConnected) break;
              if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 3) { complete = true; break; }
              const previous = scroller.scrollTop;
              scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.75);
              if (previous === scroller.scrollTop) break;
            }
          }
          if (helpers.identity() !== accountId) throw new Error('Tài khoản Teams thay đổi khi đang tải.');
          const collapsed = document.querySelectorAll('[role="treeitem"][aria-expanded="false"][data-conversation-folder="true"], [role="treeitem"][data-item-type="chats"][aria-expanded="false"]').length;
          return { accountId, chats: [...chats.values()], partial: !complete || collapsed > 0, collapsedFolders: collapsed };
        } finally { if (scroller?.isConnected) scroller.scrollTop = original; }
      });
    } finally { this.busy = false; }
  }
  async snapshot() {
    const page = await this.console();
    const u = new URL(page.url());
    if (
      ![
        "teams.live.com",
        "login.live.com",
        "account.live.com",
        "login.microsoftonline.com",
        "login.microsoft.com",
      ].includes(u.hostname)
    )
      throw conflict(
        "Trang đăng nhập đã chuyển sang địa chỉ khác; cần kiểm tra trực tiếp.",
      );
    await page
      .waitForFunction(
        () =>
          Boolean(
            document.body?.innerText.trim().length > 30 ||
            document.querySelector(
              'input[type="email"], input[type="password"]',
            ),
          ),
        undefined,
        { timeout: 15000 },
      )
      .catch(() => {
        throw conflict(
          "Teams Web đang tải hoặc chưa hiển thị nội dung. Chờ rồi bấm Chụp lại.",
        );
      });
    return {
      image:
        "data:image/png;base64," +
        (await page.screenshot({ type: "png", timeout: 15000 })).toString(
          "base64",
        ),
      url: page.url(),
      width: 1200,
      height: 800,
    };
  }
  async action(raw: unknown) {
    const a = z
      .discriminatedUnion("type", [
        z.object({
          type: z.literal("click"),
          x: z.number().min(0).max(1200),
          y: z.number().min(0).max(800),
        }),
        z.object({ type: z.literal("text"), text: z.string().max(4000) }),
        z.object({
          type: z.literal("key"),
          key: z.enum([
            "Enter",
            "Tab",
            "Escape",
            "Backspace",
            "Control+A",
            "ArrowDown",
            "ArrowUp",
          ]),
        }),
        z.object({ type: z.literal("navigate"), url: z.string().max(2048) }),
      ])
      .parse(raw);
    const p = await this.console();
    if (
      a.type !== "navigate" &&
      ![
        "teams.live.com",
        "login.live.com",
        "account.live.com",
        "login.microsoftonline.com",
        "login.microsoft.com",
      ].includes(new URL(p.url()).hostname)
    )
      throw conflict(
        "Chỉ thao tác trong Teams Personal và trang đăng nhập Microsoft.",
      );
    if (a.type === "navigate")
      await p.goto(teamsChatUrl(a.url), {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    else if (a.type === "click") await p.mouse.click(a.x, a.y);
    else if (a.type === "text") await p.keyboard.insertText(a.text);
    else await p.keyboard.press(a.key);
    return { ok: true };
  }
  private async page(member: any) {
    const url = teamsChatUrl(member.chat_id);
    if (!this.context)
      throw conflict(
        "Phiên Teams Personal chưa mở. Anh đăng nhập lại ở trang Kênh.",
      );
    let p = this.pages.get(member.id);
    if (!p || p.isClosed()) {
      p = await this.context.newPage();
      this.pages.set(member.id, p);
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    }
    return p;
  }
  private async verify(page: Page, member: any) {
    if (new URL(page.url()).hostname !== "teams.live.com")
      throw conflict("Teams Personal yêu cầu đăng nhập/MFA lại.");
    const title = page.locator(
      '[data-tid="chat-header-title"], [data-tid="chat-title"], [data-tid="chat-header"] h1, [data-tid="chat-header"] h2',
    );
    if (
      (await title.count()) !== 1 ||
      clean(await title.innerText(), 100) !== member.title
    )
      throw conflict(
        "Chưa xác nhận đúng tên cuộc trò chuyện Teams. Chọn đúng chat, nhập URL và tên hiển thị chính xác.",
      );
    if(member.account_id.includes('@')){
      const s=await page.evaluate(teamsDomSnapshot),expected=new URL(member.chat_id).searchParams.get('chatId');
      if(s.accountId!==member.account_id||!expected||s.chatId!==expected)throw conflict('Phiên Brave chưa khớp tài khoản và ID nhóm Teams đã cấu hình.');
    }
    const composer = page
      .locator(
        '[contenteditable="true"][role="textbox"], .ck-editor__editable[contenteditable="true"]',
      )
      .filter({ visible: true });
    if ((await composer.count()) !== 1)
      throw conflict(
        "Chưa xác nhận được ô soạn tin Teams Personal. Giao diện có thể đã thay đổi.",
      );
    return composer;
  }
  private async macConfig() {
    const row = (
      await query(
        "SELECT config_cipher FROM bridge_connections WHERE platform='teams_personal'",
      )
    ).rows[0];
    if (!row) return null;
    const config = JSON.parse(decrypt(row.config_cipher));
    return config.transport === "coccoc_mac" ? config : null;
  }
  async macState(config: any) {
    return teamsMacState.parse(await callTeamsMac(config, "/state"));
  }
  private async macRows(config: any, member: any) {
    const s = teamsMacMessages.parse(
      await callTeamsMac(config, "/messages", { member }),
    );
    const id = new URL(member.chat_id).searchParams.get("chatId");
    if (
      s.accountId !== member.account_id ||
      s.selfName !== config.selfName ||
      s.title !== member.title ||
      !id ||
      s.chatId !== id ||
      !s.composerReady
    )
      throw conflict("Cốc Cốc chưa xác nhận đúng tài khoản và nhóm Teams.");
    return s.rows;
  }
  async check(member: any, selfName: string) {
    if (!selfName)
      throw conflict("Cần tên hiển thị tài khoản Teams để chống chuyển vòng.");
    const mac = await this.macConfig();
    let rows;
    if (mac) {
      await callTeamsMac(mac, "/bind", { member });
      rows = await this.macRows(mac, member);
    } else {
      const p = await this.page(member);
      await this.verify(p, member);
      rows = await readTeamsMessages(p);
    }
    if (!rows.length || rows.some((r) => !r.author || !Number.isFinite(r.at)))
      throw conflict(
        "Chưa đọc được tác giả/thời gian/ID ổn định từ giao diện Teams. Cần kiểm tra phiên đã đăng nhập trước khi bật.",
      );
    return {
      title: member.title,
      cursor: JSON.stringify(rows.map((r) => r.id).slice(-200)),
      note: "Teams Personal thử nghiệm: chỉ văn bản, cần duy trì phiên đăng nhập.",
    };
  }
  async poll(member: any, selfName: string) {
    if (this.busy) return;
    this.busy = true;
    try {
      const mac = await this.macConfig();
      let rows;
      if (mac) rows = await this.macRows(mac, member);
      else {
        const p = await this.page(member);
        await this.verify(p, member);
        rows = await readTeamsMessages(p);
      }
      const seen = new Set<string>(JSON.parse(member.cursor || "[]"));
      let warning: string | null = null;
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        if (!r.author || !Number.isFinite(r.at))
          throw conflict("Teams không cung cấp tác giả/thời gian tin ổn định.");
        const echo =
          this.ownReceipts.has(r.id) ||
          /^\[(?:Zalo|Tele|Discord|WhatsApp|Viber|Teams)\]\s*\n/.test(r.text) ||
          (
            await query(
              "SELECT 1 FROM bridge_deliveries WHERE target_platform='teams_personal' AND target_chat_id=$1 AND receipts ? $2 LIMIT 1",
              [member.chat_id, r.id],
            )
          ).rowCount;
        if (!echo && r.at >= new Date(member.activated_at).getTime()) {
          if (r.media) {
            warning =
              "Đã bỏ qua ảnh/file Teams chưa hỗ trợ; văn bản tiếp tục chuyển.";
            seen.add(r.id);
            continue;
          }
          if (r.text)
            await this.onMessage?.({
              platform: "teams_personal",
              accountId: member.account_id,
              chatId: member.chat_id,
              messageId: r.id,
              at: new Date(r.at),
              payload: {
                sender: clean(r.author, 100),
                sourceName: member.title,
                text: clean(r.text),
              },
            });
        }
        seen.add(r.id);
      }
      await query(
        "UPDATE bridge_members SET cursor=$2,checked_at=now(),error=$4,next_poll_at=now()+interval '5 seconds' WHERE id=$1 AND revision=$3",
        [
          member.id,
          JSON.stringify([...seen].slice(-200)),
          member.revision,
          warning,
        ],
      );
    } finally {
      this.busy = false;
    }
  }
  async send(member: any, text: string, selfName: string) {
    if (this.busy)
      throw new RelayDeliveryError(
        "Teams đang kiểm tra tin. Thử lại sau.",
        false,
        5,
      );
    this.busy = true;
    try {
      const mac = await this.macConfig();
      if (mac) {
        const r = await callTeamsMac(mac, "/send", { member, text, selfName });
        const receipt = z
          .string()
          .regex(/^\d{13,20}$/)
          .parse(r.receipt);
        this.ownReceipts.add(receipt);
        return receipt;
      }
      const p = await this.page(member),
        composer = await this.verify(p, member);
      if ((await composer.innerText()).trim())
        throw new RelayDeliveryError(
          "Teams có bản nháp. Giữ bản nháp và dừng gửi tự động.",
          false,
        );
      const before = new Set((await readTeamsMessages(p)).map((r) => r.id));
      await composer.fill(text);
      const button = p
        .locator(
          '[data-tid="sendMessageCommands-send"], [data-tid="newMessageCommands-send"]',
        )
        .filter({ visible: true });
      if ((await button.count()) !== 1) {
        await composer.fill("");
        throw new RelayDeliveryError(
          "Không xác định được nút gửi Teams. Chưa gửi tin.",
          false,
        );
      }
      await button.click({ timeout: 10000 });
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const result = (await readTeamsMessages(p)).find(
          (r) => !before.has(r.id) && r.author === selfName && r.text === text,
        );
        if (result) {
          this.ownReceipts.add(result.id);
          if (this.ownReceipts.size > 1000)
            this.ownReceipts.delete(this.ownReceipts.values().next().value!);
          return result.id;
        }
      }
      throw new RelayDeliveryError(
        "Teams chưa xác nhận ID tin vừa gửi; cần đối soát trên ứng dụng.",
        true,
      );
    } finally {
      this.busy = false;
    }
  }
  async close() {
    if(this.externalBrowser)await this.attachedBrowser?.close();
    else await this.context?.close();
    this.attachedBrowser=undefined;this.externalBrowser=false;
    this.context = undefined;
    this.pages.clear();
    return { ok: true };
  }
}
