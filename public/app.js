const root = document.querySelector("#app"),
  modal = document.querySelector("#modal");
let snapshot,
  activeConversation = null,
  lastMessages = "",
  page = "",
  refreshing = false;
let renderVersion = 0,
  renderedPage = null;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const when = (v) =>
  v
    ? new Date(v).toLocaleString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
      })
    : "Chưa kiểm tra";
const names = {
  overview: "Tổng quan",
  channels: "Zalo & Telegram",
  calendar: "Lịch · Calendar",
  connections: "Kết nối Agents",
  conversations: "Hội thoại",
  tasks: "Công việc",
  memory: "Bộ nhớ chung",
  bcp: "Main & BCP",
  events: "Nhật ký hệ thống",
};
const paths = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  channels: "M4 6h16v12H4z M8 10h3 M8 14h8 M16 6V4 M8 6V4",
  calendar:
    "M4 5h16v16H4z M8 3v4 M16 3v4 M4 9h16 M8 13h.01 M12 13h.01 M16 13h.01 M8 17h.01 M12 17h.01",
  connections: "M8 12h8 M7 7H4v10h3 M17 7h3v10h-3 M8 4v16 M16 4v16",
  conversations: "M4 4h16v12H9l-5 4z",
  tasks: "M8 5h12v16H4V5h4 M8 3h8v4H8z M8 12h8 M8 16h5",
  memory:
    "M12 3v18 M12 6C6 0 0 9 5 12c-5 5 1 12 7 7 M12 6c6-6 12 3 7 6 5 5-1 12-7 7",
  bcp: "M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6z M8 12l3 3 5-6",
  events: "M5 4h14v17H5z M8 8h8 M8 12h8 M8 16h5",
};
const icon = (n) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n]}"/></svg>`;
const labels = {
  online: "Đang hoạt động",
  offline: "Mất kết nối",
  unconfigured: "Chưa kết nối",
  checking: "Chờ kiểm tra",
  disconnected: "Chưa kết nối",
  connected: "Đã kết nối",
  connecting: "Đang kết nối",
  qr: "Chờ quét QR",
  scanned: "Chờ xác nhận",
  queued: "Đang chờ",
  running: "Đang xử lý",
  completed: "Hoàn tất",
  review: "Cần đối soát",
  failed: "Thất bại",
  resolved: "Đã đối soát",
  pending: "Chờ gửi",
  sending: "Đang gửi",
  sent: "Đã gửi",
  cancelled: "Đã hủy",
};
const badge = (state, text) =>
  `<span class="badge ${["online", "connected", "completed", "sent"].includes(state) ? "green" : ["review", "checking", "queued", "qr", "scanned", "pending"].includes(state) ? "amber" : ["offline", "failed"].includes(state) ? "red" : ""}">${escape(text || labels[state] || state)}</span>`;
const empty = (title, description = "") =>
  `<div class="empty"><div class="empty-icon">◇</div><strong>${escape(title)}</strong>${escape(description)}</div>`;
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 5000);
}
async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      ...(options.body === undefined || options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body:
      options.body === undefined
        ? undefined
        : options.body instanceof FormData
          ? options.body
          : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path != "/login") login();
    throw new Error(data.error || "Yêu cầu thất bại");
  }
  return data;
}
function login() {
  ++renderVersion;
  renderedPage = null;
  page = "login";
  root.innerHTML = `<div class="login"><div class="login-card"><div class="brand"><span class="brand-mark">z</span><div>Zalo Agent Hub<small>ONE CHAT. CONNECTED AGENTS.</small></div></div><div class="eyebrow">Không gian quản trị</div><h1>Chào mừng trở lại</h1><p>Quản lý Zalo, điều phối agent và giữ mọi cuộc hội thoại liền mạch.</p><form id="login-form"><label>Mã quản trị<input name="token" type="password" autocomplete="current-password" placeholder="Nhập mã quản trị" required></label><button class="primary">Đăng nhập dashboard →</button></form><p class="small">Lần đầu sử dụng? Mã nằm trong file <code>data/admin-token</code> trên máy chạy bot.</p><p id="login-error" role="alert"></p></div></div>`;
  document.querySelector("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/login", {
        method: "POST",
        body: { token: new FormData(e.target).get("token") },
      });
      await render();
    } catch (err) {
      document.querySelector("#login-error").textContent = err.message;
    }
  };
}
function shell() {
  root.innerHTML = `<div class="layout"><aside class="sidebar"><div class="brand"><span class="brand-mark">z</span><div>Zalo Agent Hub<small>CONTROL CENTER / 01</small></div></div><div class="nav-label">KHÔNG GIAN LÀM VIỆC</div><nav class="nav" aria-label="Điều hướng chính">${Object.entries(
    names,
  )
    .map(
      ([id, name]) =>
        `<a href="#${id}" class="${page === id ? "active" : ""}">${icon(id)}${name}</a>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-bottom"><div><span class="dot green"></span>Môi trường cục bộ</div><div class="small">Zalo & Telegram<br>Hai Agents · Một nguồn ngữ cảnh</div><button id="logout" class="subtle">Đăng xuất ↗</button></div></aside><main class="main"><header class="topbar"><span>Không gian làm việc <span class="muted">/</span> <strong>${names[page]}</strong></span><div class="top-actions"><span class="small">${new Date().toLocaleDateString("vi-VN", { day: "numeric", month: "long", year: "numeric" })}</span><span class="badge">LOCAL</span><span class="avatar" title="Quản trị viên">AD</span></div></header><div class="content" id="content"></div></main></div>`;
  document.querySelector("#logout").onclick = async () => {
    await api("/logout", { method: "POST" });
    login();
  };
}
const heading = (title, desc, action = "") =>
  `<div class="page-heading"><div><div class="eyebrow">Zalo Agent Hub / ${names[page]}</div><h1>${title}</h1><p class="small">${desc}</p></div>${action}</div>`;
function overview() {
  const s = snapshot,
    online = s.agents.filter((a) => a.enabled && a.health === "online").length,
    main = s.leadership.agent;
  return (
    heading(
      "Mọi kết nối. Một điểm điều phối.",
      "Theo dõi bot, agent và tính liên tục của cuộc hội thoại.",
      `<button data-go="channels" class="primary">＋ Thiết lập kênh chat</button>`,
    ) +
    (!online
      ? `<div class="banner">Bắt đầu bằng cách kết nối Hermes hoặc OpenClaw. Yêu cầu sẽ được lưu chờ đến khi có agent hoạt động.</div>`
      : "") +
    `<div class="stats"><div class="stat"><div class="stat-top">KẾT NỐI ZALO <span>↗</span></div><b>${s.zalo.status === "connected" ? "Đã kết nối" : "Chưa kết nối"}</b><div class="foot">Một tài khoản · Một bridge duy nhất</div></div><div class="stat"><div class="stat-top">AGENT HOẠT ĐỘNG <span>◉</span></div><b>${online}<span class="muted"> / 2</span></b><div class="foot">Main: ${main ? escape(main === "hermes" ? "Hermes" : "OpenClaw") : "Chưa có"}</div></div><div class="stat"><div class="stat-top">LỊCH SỬ CHUNG <span>▤</span></div><b>${s.counts.messages}</b><div class="foot">${s.counts.conversations} cuộc hội thoại đã lưu</div></div><div class="stat"><div class="stat-top">CÔNG VIỆC ĐANG CHỜ <span>◷</span></div><b>${s.counts.queued}</b><div class="foot">${s.counts.review} công việc cần đối soát</div></div></div><div class="grid-two"><section class="card"><div class="card-head"><h2>Luồng điều phối</h2><span class="badge purple">${s.routing.preferred === "auto" ? "TỰ ĐỘNG" : "MAIN ƯU TIÊN: " + escape(s.routing.preferred.toUpperCase())}</span></div><div class="flow"><div class="flow-node"><strong>Zalo</strong><small>Một tài khoản</small></div><span class="flow-arrow">→</span><div class="flow-node"><strong>Router</strong><small>Ngữ cảnh chung</small></div><span class="flow-arrow">⇄</span><div class="flow-branch"><div class="flow-node h"><strong>Hermes</strong><small>${main === "hermes" ? "● Main hiện tại" : "Ưu tiên điều phối"}</small></div><div class="flow-node o"><strong>OpenClaw</strong><small>${main === "openclaw" ? "● Main hiện tại" : "Thực thi / Backup"}</small></div></div></div><div class="card-body"><div class="note">Một nguồn lịch sử chung. Khi Main mất kết nối, agent còn hoạt động tiếp quản ngữ cảnh từ PostgreSQL.</div></div></section><section class="card"><div class="card-head"><h2>Sức khỏe hệ thống</h2><button class="subtle" data-go="bcp">Chi tiết ↗</button></div><div class="card-body"><div class="health-row"><div><strong class="small">Database trung tâm</strong><p class="small">PostgreSQL · Lưu trữ bền vững</p></div>${badge("online")}</div>${s.agents.map((a) => `<div class="health-row"><div><strong class="small">${a.id === "hermes" ? "Hermes" : "OpenClaw"}</strong><p class="small">API: ${a.latency_ms != null ? a.latency_ms + " ms" : "—"} · ${when(a.last_checked)}${a.last_run_ms != null ? " · AI: " + (a.last_run_ms / 1000).toFixed(1) + " giây" : ""}${a.last_run_error ? `<br><span class="red">Lượt AI lỗi: ${escape(a.last_run_error)}</span>` : ""}</p></div>${badge(a.health)}</div>`).join("")}<div class="health-row"><span class="small">Hàng đợi xử lý</span>${badge(s.routing.paused ? "review" : "online", s.routing.paused ? "Đang tạm dừng" : "Đang bật")}</div></div></section></div><div class="grid-two"><section class="card"><div class="card-head"><h2>Công việc gần đây</h2><a href="#tasks" class="small">Xem tất cả →</a></div>${taskTable(s.tasks.slice(0, 5), false)}</section><section class="card"><div class="card-head"><h2>Hoạt động hệ thống</h2><a href="#events" class="small">Nhật ký →</a></div><div class="card-body">${eventList(s.events.slice(0, 5))}</div></section></div>`
  );
}
function taskTable(tasks, actions = true) {
  return tasks.length
    ? `<div class="table-wrap"><table><thead><tr><th>Công việc</th><th>Agent</th><th>Trạng thái</th><th>Thời gian</th>${actions ? "<th>Xử lý</th>" : ""}</tr></thead><tbody>${tasks.map((t) => `<tr><td><button class="subtle mono" data-task="${t.id}">${escape(t.id.slice(0, 8))} ↗</button>${t.parent_id ? '<br><small class="muted">Nhiệm vụ con</small>' : ""}${t.error ? `<p class="small">${escape(t.error)}</p>` : ""}</td><td>${escape(t.agent || "—")}</td><td>${badge(t.status)}</td><td>${when(t.created_at)}</td>${actions ? `<td>${["review", "failed"].includes(t.status) ? `<div class="row"><button data-resolve="${t.id}" data-action="acknowledge">Đã đối soát</button><button data-resolve="${t.id}" data-action="retry">Chạy lại</button></div>` : "—"}</td>` : ""}</tr>`).join("")}</tbody></table></div>`
    : empty(
        "Chưa có công việc",
        "Các lượt xử lý của agent sẽ xuất hiện tại đây.",
      );
}
function eventList(events) {
  return events.length
    ? events
        .map(
          (e) =>
            `<div class="event"><span class="dot ${e.kind === "error" ? "" : "green"}"></span><div>${escape(e.message)}<time>${when(e.created_at)} · ${escape(e.kind)}</time></div></div>`,
        )
        .join("")
    : empty(
        "Chưa có hoạt động",
        "Nhật ký sẽ được cập nhật khi anh thiết lập kết nối.",
      );
}
const calendarZone = "Asia/Ho_Chi_Minh";
const localDateKey = (value) => {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: calendarZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  return `${p.find((x) => x.type === "year").value}-${p.find((x) => x.type === "month").value}-${p.find((x) => x.type === "day").value}`;
};
const localClock = (value) =>
  new Intl.DateTimeFormat("vi-VN", {
    timeZone: calendarZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
const localDateTimeInput = (value) =>
  `${localDateKey(value)}T${localClock(value)}`;
const monthLabel = (value) =>
  new Intl.DateTimeFormat("vi-VN", {
    timeZone: calendarZone,
    month: "long",
    year: "numeric",
  }).format(value);
let calendarMonth = new Date();
function calendarItemsForDay(job, dateKey) {
  const start = localDateKey(job.next_run_at);
  if (dateKey < start) return false;
  if (job.recurrence === "once") return dateKey === start;
  if (job.recurrence === "daily") return true;
  const days = Math.round(
    (Date.parse(`${dateKey}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) /
      86400000,
  );
  return days >= 0 && days % 7 === 0;
}
function calendarPage(data, targets) {
  const monthFirst = new Date(
    `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}-01T12:00:00+07:00`,
  );
  const offset = (monthFirst.getUTCDay() + 6) % 7;
  const gridStart = monthFirst.getTime() - offset * 86400000;
  const today = localDateKey(Date.now());
  const jobs = data.jobs || [];
  const days = Array.from({ length: 42 }, (_, i) => {
    const date = new Date(gridStart + i * 86400000);
    const key = localDateKey(date);
    const list = jobs
      .filter((j) => calendarItemsForDay(j, key))
      .sort((a, b) =>
        localClock(a.next_run_at).localeCompare(localClock(b.next_run_at)),
      );
    return `<div class="calendar-day${key === today ? " today" : ""}${key.slice(0, 7) !== localDateKey(monthFirst).slice(0, 7) ? " outside" : ""}" data-calendar-day="${key}"><div class="calendar-day-head"><span>${date.getUTCDate()}</span><button data-calendar-add="${key}" title="Tạo lịch ngày này">＋</button></div>${list
      .slice(0, 3)
      .map(
        (j) =>
          `<button class="calendar-event${j.enabled ? "" : " paused"}" data-calendar-edit="${j.id}" title="${escape(j.title)}">${localClock(j.next_run_at)} · ${escape(j.title)}</button>`,
      )
      .join(
        "",
      )}${list.length > 3 ? `<small class="muted">+${list.length - 3} lịch</small>` : ""}</div>`;
  }).join("");
  const upcoming = jobs
    .filter((j) => j.enabled)
    .sort((a, b) => new Date(a.next_run_at) - new Date(b.next_run_at))
    .slice(0, 8);
  return (
    heading(
      "Lịch · Calendar",
      "Lên lịch để Hermes/OpenClaw xử lý và gửi kết quả vào hội thoại Zalo đã được cấp quyền. Múi giờ: Việt Nam (UTC+7).",
      '<button class="primary" data-calendar-add="">＋ Tạo lịch</button>',
    ) +
    `<section class="card calendar-card"><div class="calendar-toolbar"><button data-calendar-shift="-1" aria-label="Tháng trước">‹</button><h2>${monthLabel(monthFirst)}</h2><button data-calendar-shift="1" aria-label="Tháng sau">›</button><button data-calendar-today class="subtle">Tháng này</button><span class="small muted">${jobs.filter((j) => j.enabled).length} lịch đang bật</span></div><div class="calendar-grid calendar-weekdays">${["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ nhật"].map((d) => `<strong>${d}</strong>`).join("")}</div><div class="calendar-grid">${days}</div></section><div class="calendar-bottom"><section class="card"><div class="card-head"><h2>Sắp tới</h2><span class="badge">${upcoming.length}</span></div>${upcoming.length ? `<div class="calendar-upcoming">${upcoming.map((j) => `<button data-calendar-edit="${j.id}"><span class="calendar-date">${escape(new Date(j.next_run_at).toLocaleString("vi-VN", { timeZone: calendarZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }))}</span><span><strong>${escape(j.title)}</strong><small>${escape(j.target_name)} · ${j.recurrence === "once" ? "Một lần" : j.recurrence === "daily" ? "Hằng ngày" : "Hằng tuần"}</small></span>${badge(j.enabled ? "online" : "disconnected", j.enabled ? "Đang bật" : "Tạm dừng")}</button>`).join("")}</div>` : empty("Chưa có lịch hẹn", "Tạo lịch để giao việc hoặc nhắc bot vào một hội thoại Zalo.")}</section><section class="card"><div class="card-head"><h2>Nguyên tắc gửi lịch</h2></div><div class="card-body"><p class="small">Lịch được lưu trong PostgreSQL chung và tự đưa vào hàng đợi của agent đang làm Main. Nếu agent tạm offline, việc nằm trong hàng đợi cho tới khi có agent hoạt động.</p><p class="small">Chỉ chọn được DM/nhóm đang được cấp quyền. Nếu quyền bị thu hồi trước giờ chạy, lịch tự tạm dừng để tránh gửi nhầm.</p></div></section></div>`
  );
}
function calendarDialog(item, targets, dateKey = "") {
  const d = item
    ? new Date(item.next_run_at)
    : dateKey
      ? new Date(`${dateKey}T10:00:00+07:00`)
      : new Date(Date.now() + 3600000);
  if (!item) {
    if (d.getTime() < Date.now() + 60000) d.setTime(Date.now() + 3600000);
    d.setSeconds(0, 0);
  }
  const targetValue = item ? `${item.thread_type}:${item.thread_id}` : "";
  modal.innerHTML = `<div class="row spread"><div><div class="eyebrow">LỊCH · ZALO</div><h2>${item ? "Sửa lịch" : "Tạo lịch"}</h2></div><button type="button" data-close>Đóng</button></div><form id="calendar-form"><label>Tên lịch<input name="title" maxlength="120" required value="${escape(item?.title || "")}" placeholder="Ví dụ: Tổng hợp tin buổi sáng"></label><label>Bot cần làm gì?<textarea name="prompt" maxlength="2000" rows="4" required placeholder="Mô tả rõ việc cần làm hoặc nội dung cần nhắc">${escape(item?.prompt || "")}</textarea></label><label>Gửi kết quả vào<select name="target" required><option value="">Chọn DM hoặc nhóm được cấp quyền…</option>${targets.map((t) => `<option value="${t.threadType}:${t.uid}" ${targetValue === `${t.threadType}:${t.uid}` ? "selected" : ""}>${t.threadType === 1 ? "Nhóm" : "DM"} · ${escape(t.name)}</option>`).join("")}</select></label><div class="row calendar-form-row"><label>Ngày giờ (giờ Việt Nam)<input type="datetime-local" name="runAt" required value="${localDateTimeInput(d)}"></label><label>Lặp lại<select name="recurrence"><option value="once" ${item?.recurrence === "once" || !item ? "selected" : ""}>Một lần</option><option value="daily" ${item?.recurrence === "daily" ? "selected" : ""}>Hằng ngày</option><option value="weekly" ${item?.recurrence === "weekly" ? "selected" : ""}>Hằng tuần</option></select></label></div><p class="small muted">Nhóm dùng model riêng bảo mật; DM dùng Hermes/OpenClaw. Kết quả được phản hồi vào đúng hội thoại đã chọn.</p><div id="calendar-error" class="small red"></div><div class="modal-actions"><button type="button" data-close>Hủy</button>${item ? `<button type="button" id="calendar-toggle">${item.enabled ? "Tạm dừng" : "Bật lại"}</button><button type="button" class="danger" id="calendar-delete">Xóa lịch</button>` : ""}<button class="primary">${item ? "Lưu thay đổi" : "Tạo lịch"}</button></div></form>`;
  if (!modal.open) modal.showModal();
  modal
    .querySelectorAll("[data-close]")
    .forEach((b) => (b.onclick = () => modal.close()));
  modal.querySelector("#calendar-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const [threadType, threadId] = String(f.get("target")).split(":");
    const body = {
      title: f.get("title"),
      prompt: f.get("prompt"),
      threadId,
      threadType: Number(threadType),
      runAt: f.get("runAt"),
      recurrence: f.get("recurrence"),
    };
    const submit = e.currentTarget.querySelector("button.primary");
    submit.disabled = true;
    try {
      await api(item ? `/calendar/${item.id}` : "/calendar", {
        method: item ? "PUT" : "POST",
        body,
      });
      modal.close();
      toast(item ? "Đã cập nhật lịch" : "Đã tạo lịch");
      await render();
    } catch (err) {
      modal.querySelector("#calendar-error").textContent = err.message;
      submit.disabled = false;
    }
  };
  modal
    .querySelector("#calendar-toggle")
    ?.addEventListener("click", async () => {
      try {
        await api(`/calendar/${item.id}/toggle`, {
          method: "POST",
          body: { enabled: !item.enabled },
        });
        modal.close();
        await render();
      } catch (e) {
        toast(e.message);
      }
    });
  modal
    .querySelector("#calendar-delete")
    ?.addEventListener("click", async () => {
      if (!confirm(`Xóa lịch “${item.title}”?`)) return;
      try {
        await api(`/calendar/${item.id}`, { method: "DELETE" });
        modal.close();
        toast("Đã xóa lịch");
        await render();
      } catch (e) {
        toast(e.message);
      }
    });
}
let dmContactsData = { accountId: null, contacts: [] };
let calendarData = { jobs: [] },
  calendarTargetsData = [];
let dmSearch = "",
  dmFilter = "all";
let contactKind = "all";
async function showChatSettings(target) {
  const base = "/chat-profile/" + target.kind + "/" + target.uid;
  const query = "?" + new URLSearchParams({ accountId: target.accountId });
  let state = await api(base + query);
  modal.classList.add("chat-profile-dialog");
  const p = state.profile;
  let editingNoteId = null;
  modal.innerHTML = `<div class="row spread"><div><div class="eyebrow">${target.kind === "group" ? "NHÓM" : "DM"} · ${escape(target.uid)}</div><h2>Cấu hình ${escape(target.label || target.uid)}</h2></div><button type="button" data-profile-close>Đóng</button></div><nav class="profile-tabs" aria-label="Cấu hình hội thoại">${[
    ["persona", "Tính cách"],
    ["conversation", "Hội thoại"],
    ["knowledge", "Tri thức & Skill"],
    ...(target.kind === "group" ? [["brain", "Trí nhớ & Topic"]] : []),
    ["connection", "Não & Chất lượng"],
    ["style", "Trình bày"],
    ["policy", "Quyền & Lời chào"],
  ]
    .map(
      ([key, label], i) =>
        `<button type="button" data-profile-tab="${key}" class="${i === 0 ? "primary" : "subtle"}">${label}</button>`,
    )
    .join(
      "",
    )}</nav><form id="chat-profile-form"><section data-profile-section="persona"><label>Tính cách trong nhóm / DM<textarea name="personality" maxlength="4000" rows="9" placeholder="Bot xưng hô thế nào, vai trò, cách tư duy, phong cách trao đổi…">${escape(p.personality)}</textarea></label><p class="small muted"><span id="personality-count">${p.personality.length}</span>/4000 ký tự. Nạp lại từ database cho mỗi lượt xử lý, áp dụng riêng hội thoại này.</p></section><section data-profile-section="conversation" hidden><h3>Trả lời lần lượt</h3><label class="check"><input type="checkbox" name="sequentialReplies" ${p.sequentialReplies !== false ? "checked" : ""}>Trả lời lần lượt</label><p class="small">Khi bật, bot xử lý câu hỏi theo thứ tự nhận trong hội thoại, gửi xong phản hồi trước rồi mới xử lý câu tiếp theo. Các nhóm khác vẫn hoạt động độc lập. Lượt lỗi không tự chạy lại và không khóa các câu hỏi mới.</p><p class="small muted">Khi tắt, có thể xử lý đồng thời tối đa 2 lượt; câu trả lời có thể về khác thứ tự. Nên bật Tag / Reply để dễ theo dõi. Thay đổi áp dụng cho lượt mới, không hủy lượt đang chạy.</p><h3>Tag / Reply đúng câu hỏi</h3><label>Khi trả lời<select name="replyTarget"><option value="none" ${!p.replyTarget || p.replyTarget === "none" ? "selected" : ""}>Tắt — trả lời thông thường</option><option value="reply" ${p.replyTarget === "reply" ? "selected" : ""}>Reply — trích dẫn đúng tin nhắn gốc</option><option value="tag" ${p.replyTarget === "tag" ? "selected" : ""}>Tag — nhắc đúng người hỏi</option><option value="both" ${p.replyTarget === "both" ? "selected" : ""}>Tag + Reply — nhắc người hỏi và trích dẫn câu hỏi</option></select></label><p class="small">Reply gắn với ID tin nhắn gốc, không dựa vào nội dung do AI tự đoán. Tag áp dụng trong nhóm; DM dùng Reply. Với tin cũ thiếu dữ liệu Reply, bot dùng Tag người hỏi nếu có thông tin, không gắn nhầm câu hỏi khác.</p></section>${target.kind === "group" ? `<section data-profile-section="brain" hidden><h3>Trí nhớ riêng nhóm</h3><p class="small">Tab này quản lý model tóm tắt trí nhớ nền, chạy stateless riêng. Việc chọn Agent và bật OpenClaw supporter nằm trong Não & Chất lượng; quyền lệnh nằm ở Quyền & Lời chào.</p><label class="check"><input type="checkbox" name="groupMemoryEnabled" ${p.groupMemoryEnabled !== false ? "checked" : ""}>Lắng nghe và tổng hợp nhóm được cấp quyền</label><label>Chu kỳ tổng hợp (phút)<input type="number" name="groupSummaryMinutes" min="5" max="1440" value="${p.groupSummaryMinutes || 15}"></label><p class="small muted">Ghi nhận cả tin không tag. Im lặng / thu hồi quyền dừng tiếp nhận. Tắt ghi nhớ dừng tổng hợp, giữ tương tác trực tiếp và dữ liệu đã lưu.</p><div class="row"><button type="button" id="brain-reload">Làm mới trí nhớ</button><button type="button" id="brain-summarize">Tổng hợp ngay</button><button type="button" id="brain-rebuild">Tổng hợp lại từ nguồn</button></div><div id="brain-view"></div></section>` : ""}<section data-profile-section="knowledge" hidden><h3>Tri thức tham khảo</h3><div class="row"><label class="upload-label">Chọn file<input id="profile-file" type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.pdf,.docx,.yaml,.yml"></label><button type="button" data-browse-source="folder">Browse thư mục</button><button type="button" data-browse-source="skill">Browse Skill</button></div><p class="small">File tối đa 8 MB. Thư mục đọc tối đa 100 file/20 MB. Tài liệu lớn được chọn trích đoạn phù hợp; bấm Làm mới khi file hoặc trang web thay đổi. Skill nạp hướng dẫn SKILL.md, không tự cài công cụ/chạy script.</p><div class="form-grid"><label>Link trang web<input id="profile-url" type="url" placeholder="https://…"></label><div class="profile-align-end"><button type="button" id="profile-add-url">Thêm link</button></div></div><label>Tri thức khác / ghi chú<textarea id="profile-note" maxlength="60000" rows="3" placeholder="FAQ, quy định riêng, thông tin tham khảo…"></textarea></label><button type="button" id="profile-add-note">Thêm ghi chú</button><div id="profile-browser" class="profile-browser" hidden></div><div id="profile-sources" class="profile-sources"></div><pre id="profile-source-preview" class="profile-preview" hidden></pre></section><section data-profile-section="connection" hidden><label>Não / Agent<select name="brain"><option value="auto" ${p.brain === "auto" ? "selected" : ""}>Theo Main & Backup</option><option value="hermes" ${p.brain === "hermes" ? "selected" : ""}>Hermes</option><option value="openclaw" ${p.brain === "openclaw" ? "selected" : ""}>OpenClaw</option></select></label><p class="small">Auto dùng model mặc định của Main/Backup. Khi chọn model riêng, chọn rõ agent. Nếu agent ưu tiên lỗi, hệ thống chỉ dùng backend phù hợp với chính sách bảo vệ.</p><div id="profile-model-fields"><div class="row"><button type="button" id="profile-load-models">Tải danh sách model</button><span class="small muted" id="profile-model-state"></span></div><label>Chọn model có sẵn<select id="profile-model-picker"><option value="">Chọn model hoặc nhập bên dưới</option></select></label><div class="form-grid"><label>Model ID<input name="model" value="${escape(p.model)}" placeholder="Để trống dùng mặc định"></label><label>Provider (Hermes)<input name="provider" value="${escape(p.provider)}" placeholder="Ví dụ: custom, nous, anthropic"></label></div><p class="small">OpenClaw dùng ID provider/model; lựa chọn model phụ thuộc cấu hình và quyền trên gateway.</p></div><h3>OpenClaw hỗ trợ Hermes</h3><label class="check"><input type="checkbox" name="openClawSupport" ${p.openClawSupport !== false ? "checked" : ""}>Dùng OpenClaw làm supporter khi hội thoại dùng Hermes</label><p class="small">Khi bật và cả hai agent online, Hermes sẽ giao các yêu cầu phù hợp cho OpenClaw rồi tổng hợp kết quả. Khi tắt, Hermes tự xử lý. Nếu chọn Theo Main & Backup, OpenClaw có thể tiếp quản khi Hermes offline; nếu chọn riêng Hermes, bot sẽ báo khi Hermes mất kết nối.</p><h3>Hermes tổng hợp sau OpenClaw</h3><label>Chế độ tổng hợp<select name="handoffSynthesis"><option value="fast" ${p.handoffSynthesis !== "verify" ? "selected" : ""}>Nhanh — chỉ tổng hợp kết quả, không tra cứu lại</option><option value="verify" ${p.handoffSynthesis === "verify" ? "selected" : ""}>Kiểm chứng lại — cho phép Hermes dùng công cụ (chậm hơn)</option></select></label><p class="small">Chế độ Nhanh dùng Hermes riêng không có công cụ, giữ nguyên số liệu, nguồn và phần chưa xác nhận từ OpenClaw. Chất lượng và độ dài bên dưới vẫn áp dụng; OpenClaw vẫn nghiên cứu theo yêu cầu. Chọn Kiểm chứng lại khi cần Hermes tự kiểm tra nguồn độc lập.</p><h3>Chất lượng câu trả lời</h3>${[
    ["short", "Ngắn gọn", "Suy luận đơn giản, trả lời ngắn và trực tiếp."],
    [
      "balanced",
      "Vừa đủ",
      "Suy luận khá sâu, đủ ý và dẫn link bằng chứng khi có nguồn.",
    ],
    [
      "long",
      "Dài",
      "Phân tích sâu, trình bày chi tiết, có bằng chứng và giới hạn.",
    ],
  ]
    .map(
      ([key, label, desc]) =>
        `<label class="profile-option"><input type="radio" name="quality" value="${key}" ${p.quality === key ? "checked" : ""}><span><strong>${label}</strong><small>${desc}</small></span></label>`,
    )
    .join(
      "",
    )}<p class="small">Độ sâu thực tế phụ thuộc model; hệ thống không yêu cầu hoặc hiển thị suy luận nội bộ. Không bịa link khi chưa có nguồn.</p></section><section data-profile-section="style" hidden><h3>Trình bày câu trả lời</h3><label class="profile-option"><input type="radio" name="presentation" value="color" ${p.presentation === "color" ? "checked" : ""}><span><strong>Màu Xanh · Đỏ · Vàng</strong><small>Xanh cho ý chính, đỏ cho cảnh báo, vàng cho lưu ý; dùng style native của Zalo.</small></span></label><label class="profile-option"><input type="radio" name="presentation" value="plain" ${p.presentation === "plain" ? "checked" : ""}><span><strong>Text đơn giản</strong><small>Màu chữ mặc định của Zalo (đen trên giao diện sáng).</small></span></label><label class="check"><input type="checkbox" name="emoji" ${p.emoji ? "checked" : ""}>Bật thả reaction và dùng emoji trong câu trả lời</label><p class="small">Khi bật, bot có thể thả 👍 cho tin đã nhận vào hàng đợi. Khi tắt, bot không thả reaction mới và bỏ emoji khỏi câu trả lời.</p></section><section data-profile-section="policy" hidden><h3>Thực thi lệnh hệ thống</h3><label class="check"><input type="checkbox" name="systemCommands" ${p.systemCommands ? "checked" : ""}>Cho phép thực thi lệnh hệ thống</label><label>Danh sách lệnh không được phép (mỗi dòng một lệnh/mẫu)<textarea name="deniedCommands" rows="5" maxlength="4000" placeholder="rm -rf&#10;sudo&#10;shutdown">${escape(p.deniedCommands)}</textarea></label><div id="profile-guard-state" class="note ${state.guard.ready ? "" : "warn"}">${state.guard.ready ? "Guard Hermes đang hoạt động." : "Guard Hermes chưa hoạt động; chưa thể lưu chính sách lệnh hạn chế."}</div><p class="small">Guard kiểm tra từng tool call, không chỉ nhắc bằng prompt. Khi có lệnh cấm, chỉ hỗ trợ lệnh đọc trực tiếp và chặn script/chuỗi shell. Đây không phải sandbox hệ điều hành. OpenClaw chưa có guard này: yêu cầu có chính sách hạn chế sẽ bị chặn.</p>${target.kind === "group" ? `<h3>Lời chào thành viên mới</h3><label>Nội dung chào (để trống để tắt)<textarea name="welcome" rows="4" maxlength="2000" placeholder="Chào {members}, mừng bạn đến với {group}!">${escape(p.welcome)}</textarea></label><p class="small">{members} được thay bằng tag thật của thành viên mới; {group} là tên nhóm. Nếu không dùng {members}, bot tự thêm tag vào đầu tin. Chỉ gửi khi nhóm được cấp quyền, bật phản hồi và không ở chế độ Im lặng.</p>` : ""}</section><footer class="profile-footer"><span id="profile-save-state" class="small muted">Thay đổi áp dụng từ lượt xử lý tiếp theo.</span><button type="submit" class="primary">Lưu cấu hình hội thoại</button></footer></form>`;
  if (!modal.open) modal.showModal();
  if (target.kind === "group") await renderGroupBrain(base, query, target);
  const form = modal.querySelector("#chat-profile-form");
  for (const option of form.elements.brain.options) {
    if (option.value === "auto") continue;
    const agent = (state.agents || []).find((item) => item.id === option.value);
    const online = Boolean(agent?.enabled && agent.health === "online");
    option.disabled = !online;
    option.textContent =
      (option.value === "hermes" ? "Hermes" : "OpenClaw") +
      (online
        ? " · Đã kết nối"
        : agent?.enabled && agent.health === "checking"
          ? " · Đang kiểm tra"
          : " · Chưa kết nối");
  }
  if (target.kind === "group") {
    const connection = modal.querySelector(
      '[data-profile-section="connection"]',
    );
    connection.insertAdjacentHTML(
      "afterbegin",
      '<p class="note">Agent đã chọn sẽ xử lý câu hỏi nhóm. Khi chọn Hermes và bật OpenClaw supporter, Hub có thể giao việc cho OpenClaw rồi đưa kết quả lại Hermes tổng hợp. “Theo Main & Backup” đi theo Agent chính; nếu chọn Agent riêng thì bot không tự chuyển sang Agent khác khi Agent đó offline.</p>',
    );
    modal.querySelector("#profile-guard-state").hidden = true;
  }

  const noteInput = modal.querySelector("#profile-note");
  const noteAdd = modal.querySelector("#profile-add-note");
  const noteState = document.createElement("span");
  noteState.className = "small muted";
  noteState.hidden = true;
  const noteCancel = document.createElement("button");
  noteCancel.type = "button";
  noteCancel.textContent = "Hủy sửa";
  noteCancel.hidden = true;
  noteAdd.before(noteState, noteCancel);
  noteCancel.onclick = () => {
    editingNoteId = null;
    noteInput.value = "";
    noteAdd.textContent = "Thêm ghi chú";
    noteState.hidden = true;
    noteCancel.hidden = true;
  };
  modal.querySelector("[data-profile-close]").onclick = () => modal.close();
  modal.querySelectorAll("[data-profile-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        modal
          .querySelectorAll("[data-profile-section]")
          .forEach(
            (s) =>
              (s.hidden = s.dataset.profileSection !== b.dataset.profileTab),
          );
        modal
          .querySelectorAll("[data-profile-tab]")
          .forEach((x) => (x.className = x === b ? "primary" : "subtle"));
      }),
  );
  form.elements.personality.oninput = (e) =>
    (modal.querySelector("#personality-count").textContent =
      e.target.value.length);
  const modelFields = modal.querySelector("#profile-model-fields");
  const providerLabel = form.elements.provider.closest("label");
  const syncBrain = () => {
    modelFields.hidden = form.elements.brain.value === "auto";
    providerLabel.hidden = form.elements.brain.value === "openclaw";
  };
  syncBrain();
  let modelOptions = [];
  const loadAgentModels = async (button) => {
    if (form.elements.brain.value === "auto") return;
    button.disabled = true;
    const label = modal.querySelector("#profile-model-state");
    label.textContent = "Đang tải model từ " + form.elements.brain.value + "…";
    try {
      const result = await api(
        "/agents/" + form.elements.brain.value + "/catalog",
      );
      modelOptions = result.models || [];
      modal.querySelector("#profile-model-picker").innerHTML =
        '<option value="">Chọn model</option>' +
        modelOptions
          .map((m, i) => `<option value="${i}">${escape(m.label)}</option>`)
          .join("");
      label.textContent =
        result.error ||
        result.note ||
        `${modelOptions.length} model đã tải từ ${form.elements.brain.value}.`;
    } catch (err) {
      label.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };
  form.elements.brain.onchange = async () => {
    form.elements.model.value = "";
    form.elements.provider.value = "";
    syncBrain();
    if (form.elements.brain.value !== "auto")
      await loadAgentModels(modal.querySelector("#profile-load-models"));
  };
  modal.querySelector("#profile-load-models").onclick = (e) =>
    loadAgentModels(e.currentTarget);
  if (form.elements.brain.value !== "auto")
    void loadAgentModels(modal.querySelector("#profile-load-models"));
  modal.querySelector("#profile-model-picker").onchange = (e) => {
    const m = modelOptions[Number(e.target.value)];
    if (e.target.value !== "" && m) {
      form.elements.model.value = m.id;
      form.elements.provider.value = m.provider || "";
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form),
      button = form.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const profile = {
        groupMemoryEnabled:
          target.kind === "group"
            ? f.has("groupMemoryEnabled")
            : p.groupMemoryEnabled,
        groupSummaryMinutes: Number(
          f.get("groupSummaryMinutes") || p.groupSummaryMinutes || 15,
        ),
        personality: String(f.get("personality") || ""),
        brain: f.get("brain"),
        model: String(f.get("model") || ""),
        provider: String(f.get("provider") || ""),
        quality: f.get("quality"),
        handoffSynthesis: f.get("handoffSynthesis") || "fast",
        openClawSupport: f.has("openClawSupport"),
        presentation: f.get("presentation"),
        emoji: f.has("emoji"),
        sequentialReplies: f.has("sequentialReplies"),
        replyTarget: String(f.get("replyTarget") || "none"),
        systemCommands: f.has("systemCommands"),
        deniedCommands: String(f.get("deniedCommands") || ""),
        welcome: String(f.get("welcome") || ""),
      };
      if (profile.brain === "auto") {
        profile.model = "";
        profile.provider = "";
      }
      await api(base, {
        method: "PUT",
        body: { accountId: target.accountId, profile },
      });
      modal.querySelector("#profile-save-state").textContent =
        "Đã lưu " + new Date().toLocaleTimeString("vi-VN");
      toast("Đã lưu cấu hình riêng cho hội thoại");
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  };
  async function reloadSources() {
    const data = await api(base + query);
    state.sources = data.sources;
    const el = modal.querySelector("#profile-sources");
    el.innerHTML = state.sources.length
      ? state.sources
          .map(
            (s) =>
              `<div class="source-item"><div><strong>${escape(s.name)}</strong> <span class="badge">${escape(s.source_type)}</span><p class="small">${escape(s.locator)} · ${s.characters} ký tự · ${when(s.updated_at)}</p></div><div class="row">${s.source_type === "note" ? `<button type="button" data-source-edit="${s.id}">Sửa ghi chú</button>` : ""}<button type="button" data-source-refresh="${s.id}">Làm mới</button><button type="button" data-source-remove="${s.id}" class="danger">Gỡ nguồn</button></div></div>`,
          )
          .join("")
      : empty("Chưa gắn tri thức/skill riêng");
    el.querySelectorAll("[data-source-edit]").forEach((b) =>
      b.addEventListener("click", () => {
        const source = state.sources.find((x) => x.id === b.dataset.sourceEdit);
        if (!source || source.source_type !== "note") return;
        editingNoteId = source.id;
        noteInput.value = source.content || "";
        noteAdd.textContent = "Lưu thay đổi";
        noteState.textContent = `Đang sửa ghi chú “${source.name}”.`;
        noteState.hidden = false;
        noteCancel.hidden = false;
        noteInput.focus();
        noteInput.scrollIntoView({ behavior: "smooth", block: "center" });
      }),
    );
    el.querySelectorAll("[data-source-refresh]").forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            await api(
              base + "/sources/" + b.dataset.sourceRefresh + "/refresh" + query,
              { method: "POST" },
            );
            await reloadSources();
            toast("Đã làm mới nội dung");
          } catch (err) {
            toast(err.message);
            b.disabled = false;
          }
        }),
    );
    el.querySelectorAll("[data-source-remove]").forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            await api(base + "/sources/" + b.dataset.sourceRemove + query, {
              method: "DELETE",
            });
            await reloadSources();
          } catch (err) {
            toast(err.message);
            b.disabled = false;
          }
        }),
    );
  }
  async function attach(source) {
    await api(base + "/sources", {
      method: "POST",
      body: { accountId: target.accountId, source },
    });
    await reloadSources();
    toast("Đã gắn nguồn riêng cho hội thoại");
  }
  modal.querySelector("#profile-file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("File tối đa 8 MB");
      const data = new FormData();
      data.append("file", file);
      await api(base + "/upload" + query, { method: "POST", body: data });
      await reloadSources();
      toast("Đã đọc và gắn file");
    } catch (err) {
      toast(err.message);
    } finally {
      e.target.value = "";
    }
  };
  modal.querySelector("#profile-add-url").onclick = async (e) => {
    const input = modal.querySelector("#profile-url");
    e.target.disabled = true;
    try {
      await attach({ type: "url", locator: input.value });
      input.value = "";
    } catch (err) {
      toast(err.message);
    } finally {
      e.target.disabled = false;
    }
  };
  modal.querySelector("#profile-add-note").onclick = async (e) => {
    const input = modal.querySelector("#profile-note");
    e.target.disabled = true;
    try {
      if (editingNoteId) {
        await api(base + "/sources/" + editingNoteId + query, {
          method: "PUT",
          body: { accountId: target.accountId, content: input.value },
        });
        editingNoteId = null;
        noteState.hidden = true;
        noteCancel.hidden = true;
        e.target.textContent = "Thêm ghi chú";
        await reloadSources();
        toast("Đã cập nhật ghi chú");
      } else {
        await attach({ type: "note", content: input.value });
      }
      input.value = "";
    } catch (err) {
      toast(err.message);
    } finally {
      e.target.disabled = false;
    }
  };
  async function browse(path, type) {
    const panel = modal.querySelector("#profile-browser");
    panel.hidden = false;
    panel.textContent = "Đang đọc thư mục…";
    try {
      const data = await api(
        "/library/browse" + (path ? "?" + new URLSearchParams({ path }) : ""),
      );
      panel.innerHTML = `<div class="row spread"><strong>${type === "skill" ? "Chọn Skill" : "Chọn thư mục tri thức"}</strong><button type="button" data-browser-close>Đóng Browse</button></div><label>Vùng tài liệu<select id="profile-library-root">${data.roots.map((r) => `<option value="${escape(r)}" ${r === data.path ? "selected" : ""}>${escape(r)}</option>`).join("")}</select></label><p class="mono">${escape(data.path)}</p><div class="row">${data.parent ? '<button type="button" data-parent>↑ Thư mục cha</button>' : ""}${type === "folder" ? '<button type="button" class="primary" data-use-folder>Dùng thư mục này</button>' : ""}</div><div class="browser-entries">${data.entries.map((x) => `<button type="button" data-library-path="${escape(x.path)}" data-directory="${x.directory}">${x.directory ? "▸" : "▤"} ${escape(x.name)}</button>`).join("")}</div>`;
      panel.querySelector("[data-browser-close]").onclick = () =>
        (panel.hidden = true);
      panel.querySelector("#profile-library-root").onchange = (e) =>
        browse(e.target.value, type);
      panel
        .querySelector("[data-parent]")
        ?.addEventListener("click", () => browse(data.parent, type));
      panel
        .querySelector("[data-use-folder]")
        ?.addEventListener("click", async () => {
          try {
            await attach({ type: "folder", locator: data.path });
            panel.hidden = true;
          } catch (err) {
            toast(err.message);
          }
        });
      panel.querySelectorAll("[data-library-path]").forEach(
        (b) =>
          (b.onclick = async () => {
            if (b.dataset.directory === "true")
              return browse(b.dataset.libraryPath, type);
            if (type !== "skill") return;
            try {
              await attach({ type: "skill", locator: b.dataset.libraryPath });
              panel.hidden = true;
            } catch (err) {
              toast(err.message);
            }
          }),
      );
    } catch (err) {
      panel.textContent = err.message;
    }
  }
  modal
    .querySelectorAll("[data-browse-source]")
    .forEach((b) => (b.onclick = () => browse(null, b.dataset.browseSource)));
  await reloadSources();
}
modal.addEventListener("close", () =>
  modal.classList.remove("chat-profile-dialog"),
);

function dmContactsPanel() {
  const users = dmContactsData.contacts,
    allowed = users.filter((c) => c.allowed).length;
  const onboarding =
    dmContactsData.accountId && !dmContactsData.policyConfigured
      ? `<div class="note warn account-setup"><strong>Cần rà soát quyền cho tài khoản Zalo ${escape(dmContactsData.accountId)}.</strong><p>Tài khoản chưa có cấu hình riêng. Quyền của tài khoản Zalo trước không được tự áp dụng; mọi DM và nhóm đang bị chặn cho đến khi anh chọn lại. ${dmContactsData.legacyPolicyAvailable ? "Có danh sách quyền cũ được giữ lại nhưng chưa nhập vào tài khoản này." : ""}</p><ol><li>Đồng bộ nhóm rồi lọc danh sách theo Nhóm.</li><li>Chọn nhóm cần dùng và đặt chế độ <b>Tag mới trả lời</b> để tránh trả lời tràn lan.</li><li>Chỉ thêm UID DM sau khi xác minh đúng người. UID được cấp DM đồng thời có quyền Bot Owner.</li><li>Bật phản hồi nhóm sau khi đã chọn nhóm.</li></ol><button type="button" data-policy-advanced class="primary">Rà soát quyền tài khoản này</button></div>`
      : "";
  return `<section class="card" id="dm-contacts"><div class="card-head"><div><h2>Quyền trò chuyện với bot</h2><p class="small">Quyền được lưu riêng theo tài khoản Zalo đang kết nối.</p></div><div class="row"><button id="sync-zalo-groups">Đồng bộ nhóm</button><button data-policy-advanced>Cài đặt nhóm & UID</button><button id="add-dm-user" class="primary" ${dmContactsData.accountId ? "" : "disabled"}>＋ Thêm ID</button></div></div>${onboarding}<div class="card-body"><div class="row spread"><div class="row" role="group" aria-label="Lọc quyền trò chuyện"><button data-dm-filter="all" class="${dmFilter === "all" ? "primary" : "subtle"}">Tất cả (${users.length})</button><button data-dm-filter="allowed" class="${dmFilter === "allowed" ? "primary" : "subtle"}">Được phép (${allowed})</button><button data-dm-filter="pending" class="${dmFilter === "pending" ? "primary" : "subtle"}">Chưa cấp quyền (${users.length - allowed})</button></div><label class="contact-search">Tìm người dùng hoặc nhóm<input id="dm-contact-search" type="search" value="${escape(dmSearch)}" placeholder="Tìm theo tên hoặc UID…" autocomplete="off"></label></div><p class="small">Bảng gồm người dùng/nhóm đã được ghi nhận hoặc thêm ID thủ công, không phải toàn bộ lịch sử chat. Người mới nhắn bot một lần để xuất hiện; nhóm được đồng bộ từ Zalo. Chọn đúng loại và ID trước khi cấp quyền. Mỗi dòng có ba chế độ: Tag mới trả lời, Im lặng, Hóng chuyện. Tag phải là @mention đúng bot; tên gõ thường hoặc @all không tính.</p></div><div class="card-body contact-types"><div class="row" role="group" aria-label="Loại hội thoại"><button data-contact-kind="all" class="${contactKind === "all" ? "primary" : "subtle"}">DM & Nhóm</button><button data-contact-kind="dm" class="${contactKind === "dm" ? "primary" : "subtle"}">Người dùng</button><button data-contact-kind="group" class="${contactKind === "group" ? "primary" : "subtle"}">Nhóm</button></div><label class="check"><input id="groups-enabled" type="checkbox" ${dmContactsData.groupsEnabled ? "checked" : ""} ${dmContactsData.accountId ? "" : "disabled"}>Bật phản hồi trong các nhóm đã cấp quyền</label><p class="small">${dmContactsData.groupsEnabled ? "Bot áp dụng chế độ trả lời đã chọn trên từng dòng nhóm." : "Phản hồi nhóm đang tắt; cấp quyền cho từng nhóm chưa tự bật công tắc này."}</p></div><div id="dm-contact-rows">${dmContactRows()}</div></section>`;
}
function dmContactRows() {
  const norm = (v) =>
    String(v || "")
      .toLocaleLowerCase("vi")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/đ/g, "d");
  const users = dmContactsData.contacts.filter(
    (c) =>
      (contactKind === "all" || (c.kind || "dm") === contactKind) &&
      (dmFilter === "all" ||
        (dmFilter === "allowed" ? c.allowed : !c.allowed)) &&
      norm(c.display_name + " " + c.uid).includes(norm(dmSearch)),
  );
  if (!users.length)
    return empty(
      "Chưa có hội thoại phù hợp",
      dmSearch
        ? "Thử tìm tên hoặc UID khác."
        : "Gửi một tin DM mới, đồng bộ nhóm hoặc thêm ID đã biết.",
    );
  return `<div class="table-wrap"><table><thead><tr><th>Hội thoại / ID thực tế</th><th>Chế độ trả lời</th><th>Quyền truy cập</th><th>Thao tác</th></tr></thead><tbody>${users
    .map((c) => {
      const kind = c.kind || "dm",
        mode = c.mode || (c.allowed ? "all" : "silent"),
        conversationRef = c.conversationRef || "";
      return `<tr data-conversation-ref="${escape(conversationRef)}"><td><span class="badge ${kind === "group" ? "purple" : ""}">${kind === "group" ? "Nhóm" : "DM"}</span> <strong>${escape(c.display_name || "Chưa có tên hiển thị")}</strong><div class="row"><span class="mono">${escape(c.uid)}</span><button class="subtle" data-copy-uid="${escape(c.uid)}" aria-label="Sao chép UID ${escape(c.uid)}">⧉</button></div><p class="small muted">conversationRef: <span class="mono">${conversationRef ? escape(conversationRef) : "Chưa có từ OpenClaw"}</span></p><p class="small muted">${c.last_seen ? when(c.last_seen) : "Chưa nhận tin"} · ${c.message_count || 0} lượt nhận</p></td><td><select data-reply-mode data-reply-kind="${kind}" data-reply-uid="${escape(c.uid)}" data-reply-account="${escape(dmContactsData.accountId || "")}" data-previous-mode="${mode}" aria-label="Chế độ trả lời ${kind === "group" ? "nhóm" : "DM"} ${escape(c.uid)}" ${dmContactsData.accountId ? "" : "disabled"}>${[
        ["mention", "Tag mới trả lời"],
        ["silent", "Im lặng"],
        ["all", "Hóng chuyện"],
      ]
        .map(
          ([value, label]) =>
            `<option value="${value}" ${mode === value ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select>${kind === "dm" && mode === "mention" ? '<p class="small">DM không có @mention sẽ không được trả lời.</p>' : ""}</td><td>${badge(c.allowed ? "online" : "review", c.allowed ? (kind === "group" ? "Đã cấp quyền nhóm" : "Được phép DM") : "Chưa cấp quyền")}${kind === "group" && !dmContactsData.groupsEnabled ? '<p class="small">Phản hồi nhóm đang tắt</p>' : ""}</td><td><button class="subtle" data-chat-settings="${escape(c.uid)}" data-chat-kind="${kind}" data-chat-account="${escape(dmContactsData.accountId || "")}" data-chat-label="${escape(c.display_name || c.uid)}" ${dmContactsData.accountId ? "" : "disabled"}>Cấu hình riêng</button><button data-contact-access="${escape(c.uid)}" data-contact-type="${kind}" data-contact-account="${escape(dmContactsData.accountId || "")}" data-allowed="${!c.allowed}" class="${c.allowed ? "danger" : "primary"}" ${dmContactsData.accountId ? "" : "disabled"}>${c.allowed ? "Thu hồi quyền" : kind === "group" ? "Cho phép nhóm" : "Cho phép DM"}</button></td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}
function bindDmRows() {
  document.querySelectorAll("[data-chat-settings]").forEach(
    (b) =>
      (b.onclick = () =>
        showChatSettings({
          uid: b.dataset.chatSettings,
          kind: b.dataset.chatKind,
          accountId: b.dataset.chatAccount,
          label: b.dataset.chatLabel,
        }).catch((e) => toast(e.message))),
  );
  document.querySelectorAll("[data-reply-mode]").forEach((select) =>
    select.addEventListener("change", async () => {
      const mode = select.value,
        previous = select.dataset.previousMode;
      select.disabled = true;
      try {
        await api(
          "/zalo/reply-mode/" +
            select.dataset.replyKind +
            "/" +
            select.dataset.replyUid,
          {
            method: "PUT",
            body: { accountId: select.dataset.replyAccount, mode },
          },
        );
        toast(
          "Đã lưu chế độ: " +
            {
              mention: "Tag mới trả lời",
              silent: "Im lặng",
              all: "Hóng chuyện",
            }[mode],
        );
        await render();
      } catch (err) {
        select.value = previous;
        select.disabled = false;
        toast(err.message);
      }
    }),
  );
  document.querySelectorAll("[data-copy-uid]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copyUid);
          toast("Đã sao chép UID");
        } catch {
          toast("Không sao chép được. Anh có thể chọn UID trong bảng.");
        }
      }),
  );
  document.querySelectorAll("[data-contact-access]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api(
            "/zalo/" +
              (b.dataset.contactType === "group" ? "groups" : "contacts") +
              "/" +
              b.dataset.contactAccess +
              "/access",
            {
              method: "PUT",
              body: {
                accountId: dmContactsData.accountId,
                allowed: b.dataset.allowed === "true",
              },
            },
          );
          toast(
            b.dataset.allowed === "true"
              ? b.dataset.contactType === "group"
                ? "Đã cấp quyền nhóm; mặc định chỉ trả lời khi tag đúng bot. Bật công tắc nhóm để hoạt động."
                : "Đã cho phép DM. Người dùng gửi tin mới để bắt đầu."
              : "Đã thu hồi quyền truy cập.",
          );
          await render();
        } catch (err) {
          toast(err.message);
          b.disabled = false;
        }
      }),
  );
}
function bindDmContacts() {
  document.querySelectorAll("[data-contact-kind]").forEach(
    (b) =>
      (b.onclick = () => {
        contactKind = b.dataset.contactKind;
        document
          .querySelectorAll("[data-contact-kind]")
          .forEach(
            (x) =>
              (x.className =
                x.dataset.contactKind === contactKind ? "primary" : "subtle"),
          );
        document.querySelector("#dm-contact-rows").innerHTML = dmContactRows();
        bindDmRows();
      }),
  );
  document
    .querySelector("#sync-zalo-groups")
    ?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        const result = await api("/zalo/groups/sync", { method: "POST" });
        toast(
          "Đã đồng bộ " + result.count + " nhóm, không đổi quyền truy cập.",
        );
        await render();
      } catch (err) {
        toast(err.message);
        e.target.disabled = false;
      }
    });
  document
    .querySelector("#groups-enabled")
    ?.addEventListener("change", async (e) => {
      const input = e.target;
      input.disabled = true;
      try {
        await api("/zalo/groups-enabled", {
          method: "PUT",
          body: { accountId: dmContactsData.accountId, enabled: input.checked },
        });
        await render();
      } catch (err) {
        input.checked = !input.checked;
        input.disabled = false;
        toast(err.message);
      }
    });
  document
    .querySelector("#dm-contact-search")
    ?.addEventListener("input", (e) => {
      dmSearch = e.target.value;
      document.querySelector("#dm-contact-rows").innerHTML = dmContactRows();
      bindDmRows();
    });
  document.querySelectorAll("[data-dm-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        dmFilter = b.dataset.dmFilter;
        document
          .querySelectorAll("[data-dm-filter]")
          .forEach(
            (x) =>
              (x.className =
                x.dataset.dmFilter === dmFilter ? "primary" : "subtle"),
          );
        document.querySelector("#dm-contact-rows").innerHTML = dmContactRows();
        bindDmRows();
      }),
  );
  document.querySelector("#add-dm-user")?.addEventListener("click", () => {
    const accountId = dmContactsData.accountId;
    modal.innerHTML = `<h2>Thêm quyền trò chuyện</h2><p class="small">Nhập ID thực tế và chọn đúng loại hội thoại. Có thể Đồng bộ nhóm để lấy ID trực tiếp từ Zalo.</p><form><label>Loại hội thoại<select name="kind" aria-label="Loại hội thoại"><option value="dm">Người dùng (DM)</option><option value="group">Nhóm</option></select></label><label>ID người dùng hoặc nhóm<input name="uid" type="text" inputmode="numeric" pattern="[0-9]{1,30}" maxlength="30" required autocomplete="off" placeholder="Ví dụ: 3333333333333333333"></label><div class="modal-actions"><button type="button" data-close>Hủy</button><button class="primary">Cấp quyền</button></div></form>`;
    modal.showModal();
    modal.querySelector("[data-close]").onclick = () => modal.close();
    modal.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const submit =
        e.target.querySelector("[type=submit]") ||
        e.target.querySelector(".primary");
      submit.disabled = true;
      try {
        const uid = String(new FormData(e.target).get("uid")).trim();
        const kind = new FormData(e.target).get("kind");
        await api(
          "/zalo/" +
            (kind === "group" ? "groups" : "contacts") +
            "/" +
            uid +
            "/access",
          {
            method: "PUT",
            body: { accountId, allowed: true },
          },
        );
        modal.close();
        toast("Đã thêm ID được cấp quyền");
        await render();
      } catch (err) {
        toast(err.message);
        submit.disabled = false;
      }
    };
  });
  bindDmRows();
}
function zaloRecoveryPanel() {
  const r = snapshot.zalo.recovery;
  if (!r) return "";
  const status = snapshot.zalo.status;
  const stateLabel =
    status === "connected"
      ? "Đã kết nối"
      : r.conflict
        ? "Trùng phiên Zalo"
        : r.requiresLogin
          ? "Cần đăng nhập QR"
          : r.enabled
            ? "Đang tự phục hồi"
            : "Chưa đăng nhập";
  return `<section class="card"><div class="card-head"><div><h2>Duy trì kết nối Zalo</h2><p class="small">Tự phục hồi bằng phiên đã lưu khi mạng hoặc WebSocket gián đoạn.</p></div>${badge(status === "connected" ? "online" : "review", stateLabel)}</div><div class="card-body"><div class="detail"><span>Tự kết nối lại</span><span>${r.enabled ? "Đang bật" : "Đang tắt"}</span></div><div class="detail"><span>Kết nối thành công gần nhất</span><span>${r.lastConnectedAt ? when(r.lastConnectedAt) : "Chưa có"}</span></div><div class="detail"><span>Ngắt kết nối gần nhất</span><span>${r.lastDisconnectedAt ? when(r.lastDisconnectedAt) + " · mã " + escape(r.lastCloseCode) : "Chưa ghi nhận"}</span></div><div class="detail"><span>Lượt thử trong đợt phục hồi</span><span>${r.attempts}</span></div><div class="detail"><span>Lần thử tiếp theo</span><span>${r.nextRetryAt ? new Date(r.nextRetryAt).toLocaleTimeString("vi-VN") : r.inProgress ? "Đang kết nối…" : "—"}</span></div>${snapshot.zalo.error ? `<div class="note warn">${escape(snapshot.zalo.error)}</div>` : ""}<p class="small">Tăng thời gian chờ từ khoảng 2 giây, tối đa 60 giây. Phiên bị đá cần quét QR lại; kết nối trùng cần đóng Zalo Web hoặc bridge khác trước khi thử tiếp.</p><div class="row"><button data-reconnect-zalo class="primary" ${!r.hasSession || r.requiresLogin || r.inProgress || status === "connected" ? "disabled" : ""}>Kết nối lại</button><button data-zalo-manage>Quản lý đăng nhập</button></div></div></section>`;
}
function zaloDiagnostics() {
  const d = snapshot.zalo.diagnostics || {};
  const decisions = {
    queued: "Đã xếp hàng",
    not_allowed: "UID hoặc nhóm chưa được cho phép",
    self: "Tin từ chính tài khoản bot — không tự trả lời",
    unsupported_content: "Nội dung chưa được hỗ trợ",
    duplicate: "Tin trùng",
    storage_error: "Lỗi lưu database",
    awaiting_tag: "Chờ @mention đúng bot",
    silent: "Im lặng theo cấu hình",
  };
  return `<section class="card"><div class="card-head"><h2>Chẩn đoán nhận tin Zalo</h2>${badge(snapshot.zalo.status)}</div><div class="card-body"><div class="row"><span class="badge">Đã nhận: ${d.received || 0}</span><span class="badge green">Xếp hàng: ${d.accepted || 0}</span><span class="badge amber">Bị chặn: ${d.blocked || 0}</span><span class="badge">Tin của bot: ${d.self || 0}</span></div><div class="detail"><span>Tin nhận gần nhất</span><span>${d.lastReceivedAt ? when(d.lastReceivedAt) : "Chưa có sự kiện tin nhắn từ Zalo"}</span></div><div class="detail"><span>UID người gửi thực tế</span><span class="mono">${escape(d.lastSenderId || "—")}</span></div><div class="detail"><span>Kết quả tiếp nhận</span><span>${escape(decisions[d.lastDecision] || "—")}</span></div>${d.lastError ? `<p class="small">${escape(d.lastError)}</p>` : ""}<p class="small">Bộ đếm tính từ lúc dịch vụ khởi động. Gửi tin text mới từ tài khoản được phép tới bot; tin cũ không tự chạy lại.</p></div></section>`;
}
function connections() {
  return (
    heading(
      "Kết nối Agents",
      "Cấu hình Hermes và OpenClaw. Hệ thống tự chọn Main theo trạng thái và chính sách hiện có.",
      '<button data-go="channels" class="primary">Mở Zalo & Telegram →</button>',
    ) +
    `<div class="connection-grid">${snapshot.agents.map((a) => `<section class="card"><div class="card-head"><div class="row"><div class="logo ${a.id}">${a.id === "hermes" ? "H" : "O"}</div><div><h2>${a.id === "hermes" ? "Hermes" : "OpenClaw"}</h2><p class="small">${a.id === "hermes" ? "Điều phối chính" : "Thực thi & dự phòng"}</p></div></div>${badge(a.health)}</div><div class="card-body"><p class="small">${a.id === "hermes" ? "Hiểu yêu cầu, sử dụng ngữ cảnh chung và giao nhiệm vụ cho OpenClaw khi cần." : "Nhận nhiệm vụ từ Hermes hoặc làm Main khi Hermes chưa kết nối / downtime."}</p><div class="detail"><span>API endpoint</span><span class="mono">${escape(a.base_url)}</span></div><div class="detail"><span>Agent target</span><span class="mono">${escape(a.model)}</span></div><div class="detail"><span>API key</span><span>${a.has_key ? "Đã lưu mã hóa" : "Chưa thiết lập"}</span></div>${a.last_run_ms != null ? `<div class="detail"><span>Lượt AI gần nhất</span><span>${(a.last_run_ms / 1000).toFixed(1)} giây</span></div>` : ""}${a.last_run_error ? `<div class="note warn">Lượt AI gần nhất bị lỗi: ${escape(a.last_run_error)}</div>` : ""}${a.error ? `<p class="small">${escape(a.error)}</p>` : ""}<p class="small muted">Online xác nhận kết nối API; khả năng trả lời còn phụ thuộc model/provider.</p></div><footer><button data-agent="${a.id}" class="primary">Cấu hình</button><button data-check="${a.id}" ${a.enabled ? "" : "disabled"}>Kiểm tra</button></footer></section>`).join("")}</div><div class="note">Các kênh Zalo và Telegram được quản lý riêng trong trang Zalo & Telegram.</div>`
  );
}
function channels() {
  return (
    heading(
      "Zalo & Telegram",
      "Quản lý tài khoản Zalo, quyền hội thoại và bot Telegram nhận cảnh báo.",
      '<button data-dm-jump class="primary">Quản lý quyền chat →</button>',
    ) +
    `<div class="connection-grid"><section class="card"><div class="card-head"><div class="row"><div class="logo zalo">Z</div><div><h2>Zalo cá nhân</h2><p class="small">Kênh hội thoại</p></div></div>${badge(snapshot.zalo.status)}</div><div class="card-body"><p class="small">Đăng nhập bằng mã QR để bot nhận và phản hồi tin nhắn trên một tài khoản Zalo.</p><div class="detail"><span>Tài khoản</span><span>${escape(snapshot.zalo.accountId || "Chưa đăng nhập")}</span></div><div class="detail"><span>Thư viện</span><span>zca-js</span></div><div class="detail"><span>Truy cập</span><span>Danh sách cho phép</span></div>${snapshot.zalo.error ? `<p class="small">${escape(snapshot.zalo.error)}</p>` : ""}</div><footer><button data-zalo class="primary">${snapshot.zalo.status === "connected" ? "Quản lý Zalo" : "Kết nối Zalo"}</button><button data-policy>Phân quyền</button></footer></section><section class="card"><div class="card-head"><div class="row"><div class="logo telegram">T</div><div><h2>Telegram</h2><p class="small">Cảnh báo sự cố</p></div></div>${badge(snapshot.telegram?.status || "disconnected")}</div><div class="card-body"><p class="small">Kết nối bot riêng do @BotFather tạo để nhận cảnh báo khi Zalo hoặc Agents mất kết nối.</p><div class="detail"><span>Bot</span><span>${snapshot.telegram?.botUsername ? "@" + escape(snapshot.telegram.botUsername) : "Chưa cấu hình"}</span></div><div class="detail"><span>Tài khoản nhận</span><span>${snapshot.telegram?.linked ? escape(snapshot.telegram.chatName || "Đã liên kết") : "Chưa liên kết"}</span></div><div class="detail"><span>Token</span><span>${snapshot.telegram?.tokenMasked ? escape(snapshot.telegram.tokenMasked) : "Chưa lưu"}</span></div>${snapshot.telegram?.lastError ? `<p class="small red">${escape(snapshot.telegram.lastError)}</p>` : ""}</div><footer><button data-telegram class="primary">${snapshot.telegram?.tokenMasked ? "Cấu hình bot" : "Kết nối bot"}</button><button data-telegram-link ${!snapshot.telegram?.tokenMasked || snapshot.telegram?.linked ? "disabled" : ""}>${snapshot.telegram?.linked ? "Đã nối người nhận" : "Nối người nhận"}</button><button data-telegram-test ${!snapshot.telegram?.linked ? "disabled" : ""}>Gửi tin thử</button></footer></section></div><div class="note warn">Telegram nhận cảnh báo sự cố của Zalo và Agents. Hội thoại người dùng với Agents vẫn được xử lý trên Zalo.</div>` +
    dmContactsPanel() +
    zaloRecoveryPanel() +
    zaloDiagnostics()
  );
}
async function showAgent(id) {
  const a = snapshot.agents.find((a) => a.id === id);
  modal.innerHTML = `<h2>Kết nối ${id === "hermes" ? "Hermes" : "OpenClaw"}</h2><p class="small">Nhập endpoint API của agent đang chạy. Bot không thay đổi cài đặt agent của anh.</p><form id="agent-form"><label>API base URL (kết thúc bằng /v1)<input name="baseUrl" type="url" value="${escape(a.base_url)}" required></label><label>Agent target / model<input name="model" value="${escape(a.model)}" required></label><label>API key<input name="apiKey" type="password" placeholder="${a.has_key ? "Để trống để giữ key đã lưu" : "Nhập Bearer token"}" autocomplete="new-password"></label><label class="check"><input type="checkbox" name="enabled" ${a.enabled ? "checked" : ""}>Bật kết nối agent này</label><div class="note">Lưu cấu hình, sau đó bấm Kiểm tra. API key được mã hóa và không trả lại trình duyệt.</div><div class="modal-actions"><button type="button" data-close>Hủy</button><button class="primary">Lưu kết nối</button></div></form>`;
  modal.showModal();
  modal.querySelector("[data-close]").onclick = () => modal.close();
  modal.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/agents/" + id, {
        method: "PUT",
        body: {
          baseUrl: f.get("baseUrl"),
          model: f.get("model"),
          apiKey: f.get("apiKey"),
          enabled: f.has("enabled"),
        },
      });
      modal.close();
      toast("Đã lưu cấu hình kết nối");
      await render();
    } catch (err) {
      toast(err.message);
    }
  };
}
let qrRequestPending = false;
function syncZaloDialog(data) {
  if (!modal.open || !modal.querySelector("#qr-state")) return;
  modal.querySelector("#qr-state").innerHTML = qrContent(data);
  const start = modal.querySelector("#start-qr");
  if (start) {
    start.disabled =
      qrRequestPending || ["connecting", "qr", "scanned"].includes(data.status);
    start.textContent = data.error
      ? "Thử lại — tạo QR mới"
      : data.status === "qr"
        ? "Đang chờ quét QR"
        : data.status === "scanned"
          ? "Chờ xác nhận trên điện thoại"
          : data.status === "connecting"
            ? "Đang tạo mã QR…"
            : "Tạo mã QR";
    if (
      data.recovery?.hasSession &&
      !data.loginPending &&
      !["qr", "scanned"].includes(data.status)
    ) {
      start.textContent = "Đăng nhập lại bằng QR";
      start.disabled = qrRequestPending;
    }
    if (data.status === "connected") {
      modal.close();
      toast("Zalo đã kết nối");
      void render();
    }
  }
}
async function requestZaloQr() {
  if (qrRequestPending) return;
  qrRequestPending = true;
  syncZaloDialog({ status: "connecting" });
  try {
    await api("/zalo/connect", { method: "POST" });
    syncZaloDialog(await api("/zalo"));
  } catch (err) {
    syncZaloDialog({ status: "disconnected", error: err.message });
    toast(err.message);
  } finally {
    qrRequestPending = false;
    const start = modal.querySelector("#start-qr");
    if (start && modal.querySelector('#qr-state [role="alert"]'))
      start.disabled = false;
  }
}
async function showZalo() {
  const data = await api("/zalo");
  modal.innerHTML = `<h2>Kết nối Zalo</h2><p class="small">Mở Zalo trên điện thoại → Quét QR → Xác nhận đăng nhập.</p><div id="qr-state" aria-live="polite">${qrContent(data)}</div><div class="modal-actions"><button data-close>Đóng</button>${data.status === "connected" ? '<button class="danger" id="disconnect-zalo">Ngắt kết nối</button>' : '<button class="primary" id="start-qr">Tạo mã QR</button>'}</div>`;
  if (!modal.open) modal.showModal();
  modal.querySelector("[data-close]").onclick = () => modal.close();
  const start = modal.querySelector("#start-qr");
  if (start) start.onclick = requestZaloQr;
  const disconnect = modal.querySelector("#disconnect-zalo");
  if (disconnect)
    disconnect.onclick = async () => {
      if (!confirm("Ngắt kết nối và xóa phiên Zalo đã lưu?")) return;
      try {
        await api("/zalo/disconnect", { method: "POST" });
        modal.close();
        await render();
      } catch (err) {
        toast(err.message);
      }
    };
  syncZaloDialog(data);
  if (
    data.status === "disconnected" &&
    (!data.recovery?.hasSession || data.recovery?.requiresLogin)
  )
    await requestZaloQr();
}
async function showTelegram() {
  let state = await api("/telegram");
  const renderDialog = () => {
    modal.innerHTML = `<h2>Kết nối Telegram</h2><p class="small">Tạo bot riêng cho cảnh báo bằng @BotFather. Token được mã hóa trong PostgreSQL. Sau khi lưu, nối tài khoản Telegram nhận cảnh báo bằng link riêng.</p><div id="telegram-status" class="card-body"><div class="detail"><span>Trạng thái bot</span><span>${badge(state.status)}</span></div><div class="detail"><span>Tên bot</span><span>${state.botUsername ? "@" + escape(state.botUsername) : "Chưa cài"}</span></div><div class="detail"><span>Token đã lưu</span><span>${escape(state.tokenMasked || "Chưa có")}</span></div><div class="detail"><span>Tài khoản nhận cảnh báo</span><span>${state.linked ? escape(state.chatName || "Đã nối") : "Chưa nối"}</span></div>${state.lastError ? `<p class="small red">${escape(state.lastError)}</p>` : ""}</div><form id="telegram-form"><label>${state.tokenMasked ? "Đổi token bot" : "Token bot Telegram"}<input name="token" type="password" autocomplete="new-password" placeholder="123456789:ABC…" maxlength="200" ${state.tokenMasked ? "" : "required"}></label><div class="note">Lưu sẽ kiểm tra token bằng getMe của Telegram. Không dùng token của bot Telegram khác đang vận hành.</div><div id="telegram-link-result" class="small"></div><div class="modal-actions"><button type="button" data-close>Đóng</button>${state.tokenMasked ? `<button type="button" id="telegram-link" ${state.linked ? "hidden" : ""}>Nối tài khoản nhận</button><button type="button" id="telegram-test" ${state.linked ? "" : "disabled"}>Gửi tin thử</button><button type="button" class="danger" id="telegram-disconnect">Ngắt bot</button>` : ""}<button class="primary" ${!state.tokenMasked ? "" : ""}>${state.tokenMasked ? "Lưu token mới" : "Kết nối bot"}</button></div></form>`;
    if (!modal.open) modal.showModal();
    modal.querySelector("[data-close]").onclick = () => modal.close();
    modal.querySelector("#telegram-form").onsubmit = async (e) => {
      e.preventDefault();
      const token = new FormData(e.target).get("token");
      if (!String(token || "").trim()) return;
      try {
        state = await api("/telegram", {
          method: "PUT",
          body: { token: String(token).trim() },
        });
        toast("Đã kiểm tra và lưu bot Telegram");
        renderDialog();
        await render();
      } catch (err) {
        toast(err.message);
      }
    };
    modal
      .querySelector("#telegram-link")
      ?.addEventListener("click", async (e) => {
        e.target.disabled = true;
        try {
          const result = await api("/telegram/link", { method: "POST" });
          modal.querySelector("#telegram-link-result").innerHTML =
            `<p>Mở Telegram và bấm Start trong vòng 10 phút:</p><a href="${escape(result.url)}" target="_blank" rel="noopener">${escape(result.url)}</a>`;
        } catch (err) {
          toast(err.message);
        } finally {
          e.target.disabled = false;
        }
      });
    modal
      .querySelector("#telegram-test")
      ?.addEventListener("click", async (e) => {
        e.target.disabled = true;
        try {
          await api("/telegram/test", { method: "POST" });
          toast("Đã gửi tin thử vào Telegram");
        } catch (err) {
          toast(err.message);
        } finally {
          e.target.disabled = false;
        }
      });
    modal
      .querySelector("#telegram-disconnect")
      ?.addEventListener("click", async () => {
        if (!confirm("Ngắt bot Telegram và xóa thông tin liên kết?")) return;
        try {
          state = await api("/telegram", { method: "DELETE" });
          renderDialog();
          await render();
        } catch (err) {
          toast(err.message);
        }
      });
  };
  renderDialog();
  const refreshTelegramStatus = setInterval(async () => {
    if (!modal.open || !modal.querySelector("#telegram-status")) return;
    try {
      state = await api("/telegram");
      modal.querySelector("#telegram-status").innerHTML =
        `<div class="detail"><span>Trạng thái bot</span><span>${badge(state.status)}</span></div><div class="detail"><span>Tên bot</span><span>${state.botUsername ? "@" + escape(state.botUsername) : "Chưa cài"}</span></div><div class="detail"><span>Token đã lưu</span><span>${escape(state.tokenMasked || "Chưa có")}</span></div><div class="detail"><span>Tài khoản nhận cảnh báo</span><span>${state.linked ? escape(state.chatName || "Đã nối") : "Chưa nối"}</span></div>${state.lastError ? `<p class="small red">${escape(state.lastError)}</p>` : ""}`;
      const test = modal.querySelector("#telegram-test");
      if (test) test.disabled = !state.linked;
      const link = modal.querySelector("#telegram-link");
      if (link) link.hidden = state.linked;
    } catch {}
  }, 2000);
  modal.addEventListener("close", () => clearInterval(refreshTelegramStatus), {
    once: true,
  });
}
function qrContent(data) {
  if (data.qr)
    return `<img class="qr" alt="Mã QR đăng nhập Zalo" src="${escape(data.qr)}">${badge(data.status)}<p class="small">${data.status === "scanned" ? "Đã quét mã. Hãy xác nhận đăng nhập trên điện thoại." : "Quét mã bằng ứng dụng Zalo trên điện thoại."}</p>`;
  const hint =
    data.error ||
    (data.status === "connected"
      ? "Tài khoản: " + data.accountId
      : data.status === "connecting"
        ? "Đang lấy mã QR từ Zalo, vui lòng chờ…"
        : data.status === "scanned"
          ? "Hãy xác nhận đăng nhập trên điện thoại."
          : "Bấm Tạo mã QR để bắt đầu.");
  return `<div class="empty">${badge(data.status)}<p ${data.error ? 'role="alert"' : 'role="status"'}>${escape(hint)}</p></div>`;
}
setInterval(async () => {
  if (!modal.open || !modal.querySelector("#qr-state") || qrRequestPending)
    return;
  try {
    syncZaloDialog(await api("/zalo"));
  } catch (err) {
    syncZaloDialog({ status: "disconnected", error: err.message });
  }
}, 1000);
async function showPolicy() {
  const { policy } = await api("/zalo");
  modal.innerHTML = `<h2>Quyền truy cập Zalo</h2><p class="small">Cấu hình chỉ áp dụng cho tài khoản Zalo đang kết nối. Các UID trong danh sách vừa được phép DM, vừa được nhận diện là Bot Owner. Yêu cầu rõ ràng từ Owner được thực hiện ngay; nếu thiếu đối tượng, nội dung hoặc phạm vi, bot sẽ hỏi phần còn thiếu. Owner vẫn tuân theo quyền nhóm, quyền công cụ và guard hệ thống. Nhập UID chính xác, phân tách bằng dấu phẩy. Để trống nghĩa là không cấp quyền DM/Owner cho ai.</p>${policy.legacyPolicyAvailable ? '<div class="note warn">Có cấu hình quyền cũ đang được giữ lại. Nạp vào biểu mẫu để rà soát; quyền chỉ được chuyển sang tài khoản này sau khi anh bấm Lưu.</div><button type="button" id="load-legacy-policy">Nạp quyền cũ để rà soát</button>' : ""}<form><label>UID Bot Owner / người dùng được phép<textarea name="users" placeholder="123456789, 987654321">${escape(policy.allowUsers.join(", "))}</textarea></label><label class="check"><input type="checkbox" name="groups" ${policy.groupsEnabled ? "checked" : ""}>Cho phép bot xử lý tin trong nhóm đã chọn</label><label>ID nhóm được phép<textarea name="groupIds">${escape(policy.allowGroups.join(", "))}</textarea></label><p class="small">Nhóm mới được đặt mặc định là “Tag mới trả lời”. Chỉ bật phản hồi nhóm sau khi đã rà soát đúng ID nhóm.</p><div class="modal-actions"><button type="button" data-close>Hủy</button><button class="primary">Lưu phân quyền</button></div></form>`;
  modal.showModal();
  modal.querySelector("[data-close]").onclick = () => modal.close();
  modal.querySelector("#load-legacy-policy")?.addEventListener("click", async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const legacy = await api("/zalo/policy/legacy");
      modal.querySelector('[name="users"]').value = legacy.allowUsers.join(", ");
      modal.querySelector('[name="groupIds"]').value = legacy.allowGroups.join(", ");
      modal.querySelector('[name="groups"]').checked = legacy.groupsEnabled;
      toast("Đã nạp vào biểu mẫu. Rà soát ID rồi bấm Lưu để áp dụng cho tài khoản này.");
    } catch (err) {
      toast(err.message);
      button.disabled = false;
    }
  });
  modal.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target),
      split = (x) =>
        String(x)
          .split(/[\s,]+/)
          .filter(Boolean);
    try {
      await api("/zalo/policy", {
        method: "PUT",
        body: {
          allowUsers: split(f.get("users")),
          allowGroups: split(f.get("groupIds")),
          groupsEnabled: f.has("groups"),
        },
      });
      modal.close();
      toast("Đã lưu quyền truy cập");
    } catch (err) {
      toast(err.message);
    }
  };
}
async function conversations() {
  const list = await api("/conversations");
  const readOnly =
    list.find((c) => c.id === activeConversation)?.source === "zalo";
  return (
    heading(
      "Hội thoại & ngữ cảnh",
      "Lịch sử lưu chung cho Hermes và OpenClaw. Chat thử dùng cùng bộ điều phối.",
      `<button id="new-chat" class="primary">＋ Chat thử mới</button>`,
    ) +
    `<section class="card"><div class="chat-layout"><aside class="conversation-list">${list.length ? list.map((c) => `<button data-conversation="${escape(c.id)}" class="${activeConversation === c.id ? "selected" : ""}">${escape(c.title)}<small>${c.source === "zalo" ? "Zalo" : "Dashboard"} · ${c.message_count} tin</small></button>`).join("") : empty("Chưa có hội thoại")}</aside><div class="chat-panel"><div class="card-head"><h2>${activeConversation ? "Lịch sử hội thoại" : "Chat thử với Main"}</h2>${badge(snapshot.leadership.agent ? "online" : "queued", snapshot.leadership.agent || "Chưa có Main")}</div><div class="chat-messages" id="messages">${empty("Bắt đầu cuộc hội thoại", "Gửi một tin nhắn để thử agent và ngữ cảnh dùng chung.")}</div><form class="chat-form" id="chat-form"><label class="sr-only" hidden for="chat-input">Tin nhắn</label><textarea id="chat-input" name="content" placeholder="${readOnly ? "Hội thoại Zalo chỉ xem tại đây. Bấm Chat thử mới để thử agent." : "Nhập yêu cầu cho Main…"}" ${readOnly ? "disabled" : ""} required maxlength="12000"></textarea><button class="primary" ${readOnly ? "disabled" : ""}>Gửi →</button></form></div></div></section>`
  );
}
async function updateMessages() {
  if (page !== "conversations" || !activeConversation) return;
  const messages = await api(
    "/conversations/" + encodeURIComponent(activeConversation) + "/messages",
  );
  const signature = JSON.stringify(messages);
  if (signature === lastMessages) return;
  lastMessages = signature;
  const el = document.querySelector("#messages");
  if (!el) return;
  el.innerHTML =
    messages
      .map(
        (m) =>
          `<div class="message ${m.role === "user" ? "user" : ""}"><small>${escape(m.role === "user" ? "Anh" : m.agent || "Hệ thống")} · ${when(m.created_at)}</small>${escape(m.content)}</div>`,
      )
      .join("") || empty("Chưa có tin nhắn");
  el.scrollTop = el.scrollHeight;
}
function bcp() {
  const r = snapshot.routing;
  return (
    heading(
      "Duy trì hoạt động, giữ đúng ngữ cảnh",
      "Cấu hình Main / Backup và theo dõi những giới hạn phục hồi hiện tại.",
    ) +
    `<div class="banner">Hiện chạy một dịch vụ và một PostgreSQL. Chuyển agent đã có cơ chế; HA nhiều máy, sao lưu ngoài máy và diễn tập thảm họa chưa được triển khai.</div><div class="grid-equal"><section class="card"><div class="card-head"><h2>Chính sách điều phối</h2>${badge(snapshot.leadership.agent ? "online" : "queued", snapshot.leadership.agent || "Chưa có Main")}</div><div class="card-body"><form id="routing-form"><label>Main ưu tiên<select name="preferred"><option value="auto" ${r.preferred === "auto" ? "selected" : ""}>Tự động — ưu tiên Hermes</option><option value="hermes" ${r.preferred === "hermes" ? "selected" : ""}>Hermes</option><option value="openclaw" ${r.preferred === "openclaw" ? "selected" : ""}>OpenClaw</option></select></label><div class="form-grid"><label>Số lỗi trước khi offline<input name="failureThreshold" type="number" min="1" max="10" value="${r.failureThreshold}" required></label><label>Hermes ổn định trước khi trở lại (giây)<input name="recoverySeconds" type="number" min="10" max="600" value="${r.recoverySeconds}" required></label></div><p class="small">Kiểm tra mỗi 10 giây. Chỉ đổi Main giữa các lượt; tác vụ mất kết nối sau khi gửi cần đối soát.</p><label class="check"><input name="paused" type="checkbox" ${r.paused ? "checked" : ""}>Tạm dừng nhận việc mới vào agent</label><button class="primary">Lưu chính sách</button></form></div></section><section class="card"><div class="card-head"><h2>Khả năng phục hồi</h2><span class="badge amber">BCP GIAI ĐOẠN 1</span></div><div class="card-body">${[
      ["Lịch sử và hàng đợi bền vững", "Đã triển khai", "online"],
      ["Một worker trên mỗi database", "Khóa PostgreSQL", "online"],
      ["Chống tự chạy lại tác vụ chưa rõ kết quả", "Cần đối soát", "online"],
      ["Backup PostgreSQL", "Cục bộ, theo yêu cầu", "review"],
      ["Database HA / máy dịch vụ dự phòng", "Chưa thiết lập", "unconfigured"],
      ["Nhật ký cục bộ khi database lỗi", "Chưa triển khai", "unconfigured"],
      ["RTO / RPO thảm họa", "Chưa diễn tập", "unconfigured"],
    ]
      .map(
        ([a, b, c]) =>
          `<div class="health-row"><span class="small">${a}</span>${badge(c, b)}</div>`,
      )
      .join(
        "",
      )}</div></section></div><section class="card"><div class="card-head"><h2>Sao lưu database</h2><button id="create-backup" class="primary">Tạo backup</button></div><div class="card-body"><p class="small">Backup nằm trên máy hiện tại. Cần sao chép ra máy khác và lưu riêng khóa mã hóa để phục hồi đầy đủ.</p><div id="backups"></div></div></section><section class="card"><div class="card-head"><h2>Phản hồi cần kiểm tra trước khi gửi lại</h2></div><div id="outbox"></div></section>`
  );
}
async function memories() {
  const [list, convs] = await Promise.all([
    api("/memories"),
    api("/conversations"),
  ]);
  return (
    heading(
      "Bộ nhớ chung",
      "Thông tin đã xác nhận, gắn với từng hội thoại để tránh lẫn dữ liệu.",
    ) +
    `<div class="grid-two"><section class="card"><div class="card-head"><h2>Thông tin đã lưu</h2><span class="badge">${list.length} MỤC</span></div><div class="card-body">${list.length ? `<div class="stack">${list.map((m) => `<div class="memory"><div class="row spread"><span class="badge">${escape(m.title || "Hội thoại")}</span><button data-delete-memory="${m.id}" class="subtle danger">Xóa</button></div><p>${escape(m.content)}</p><span class="small muted">${when(m.created_at)}</span></div>`).join("")}</div>` : empty("Chưa có bộ nhớ", "Lưu các thông tin quan trọng để cả hai agent cùng sử dụng.")}</div></section><section class="card"><div class="card-head"><h2>Thêm thông tin đã xác nhận</h2></div><div class="card-body"><form id="memory-form"><label>Cuộc hội thoại<select name="conversationId" required><option value="">Chọn cuộc hội thoại</option>${convs.map((c) => `<option value="${escape(c.id)}">${escape(c.title)}</option>`).join("")}</select></label><label>Thông tin<textarea name="content" placeholder="Ví dụ: Dự án sử dụng PostgreSQL; triển khai trên VPS…" required maxlength="4000"></textarea></label><button class="primary" ${convs.length ? "" : "disabled"}>Lưu bộ nhớ chung</button></form><p class="small">Bản đầu lưu bộ nhớ qua xác nhận thủ công. Agent chỉ nhận thông tin thuộc đúng cuộc hội thoại.</p></div></section></div>`
  );
}
async function loadOutbox() {
  const list = await api("/outbox");
  const el = document.querySelector("#outbox");
  if (!el) return;
  el.innerHTML = list.length
    ? `<div class="table-wrap"><table><thead><tr><th>Phản hồi</th><th>Trạng thái</th><th>Đối soát</th></tr></thead><tbody>${list.map((x) => `<tr><td>${x.kind === "notice" ? badge("review", "Thông báo lỗi AI") + " " : ""}${escape(x.content.slice(0, 150))}${x.error ? `<p>${escape(x.error)}</p>` : ""}</td><td>${badge(x.status)}</td><td>${x.status === "review" ? `<button data-outbox="${x.id}" data-action="sent">Đã gửi</button> <button data-outbox="${x.id}" data-action="retry">Gửi lại</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>`
    : empty(
        "Không có phản hồi đang chờ",
        "Những lần gửi bị gián đoạn sẽ được đưa vào đây để đối soát.",
      );
  el.querySelectorAll("[data-outbox]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm("Đã kiểm tra Zalo và xác nhận lựa chọn này?")) return;
        await act(() =>
          api("/outbox/" + b.dataset.outbox + "/resolve", {
            method: "POST",
            body: { action: b.dataset.action },
          }),
        );
        await loadOutbox();
      }),
  );
}
async function act(fn) {
  try {
    await fn();
    toast("Đã cập nhật");
    await render();
  } catch (err) {
    toast(err.message);
  }
}
async function showTask(id) {
  const {
    task,
    runs,
    children = [],
    childRuns = [],
  } = await api("/tasks/" + id);
  modal.innerHTML = `<h2>Chi tiết công việc</h2><p class="mono">${escape(task.id)}</p><div class="row">${badge(task.status)}<span class="badge">${escape(task.agent || "Chưa có agent")}</span></div><h3>Yêu cầu</h3><div class="message">${escape(task.request)}</div><h3>Kết quả / lỗi</h3><div class="message">${escape(task.result || task.error || "Chưa có kết quả")}</div>${
    children.length
      ? `<h3>Hermes → OpenClaw → Hermes</h3><p class="small muted">Dữ liệu từ hàng đợi và lượt thực thi của hệ thống.</p>${children
          .map(
            (c) =>
              `<div class="message"><div class="row"><span class="badge">OpenClaw · ${escape(c.id.slice(0, 8))}</span>${badge(c.status)}</div><p><strong>Nội dung giao việc:</strong> ${escape(c.request)}</p><p><strong>Giao lúc:</strong> ${when(c.created_at)} · <strong>Cập nhật:</strong> ${when(c.updated_at)}</p><p><strong>Kết quả:</strong> ${escape(c.result || "Chưa có kết quả xác nhận")}</p>${c.error ? `<p class="note warn">${escape(c.error)}</p>` : ""}${childRuns
                .filter((r) => r.task_id === c.id)
                .map(
                  (r) =>
                    `<p class="small">${escape(r.agent)} · ${badge(r.status)}${r.input_tokens != null ? " · " + r.input_tokens + " token vào" : ""}${r.request_bytes != null ? " · " + (r.request_bytes / 1024).toFixed(1) + " KB gửi" : ""} · ${r.finished_at ? ((new Date(r.finished_at) - new Date(r.created_at)) / 1000).toFixed(1) + " giây" : "Đang chạy"}${r.error ? " · " + escape(r.error) : ""}</p>`,
                )
                .join("")}</div>`,
          )
          .join("")}`
      : ""
  }<h3>Lượt thực thi</h3>${runs.length ? runs.map((r) => `<div class="health-row"><span>${escape(r.agent)} · ${r.phase === "synthesis" ? "Tổng hợp" : r.phase === "delegate" ? "Thực hiện việc giao" : "Xử lý chính"} · ${when(r.created_at)}${r.finished_at ? " · " + ((new Date(r.finished_at) - new Date(r.created_at)) / 1000).toFixed(1) + " giây" : ""}${r.input_tokens != null ? " · " + r.input_tokens + " token vào" : ""}</span>${badge(r.status)}${r.error ? `<p class="small">${escape(r.error)}</p>` : ""}</div>`).join("") : empty("Chưa chạy agent")}<div class="modal-actions"><button data-close>Đóng</button></div>`;
  modal.showModal();
  modal.querySelector("[data-close]").onclick = () => modal.close();
}
function bind() {
  bindDmContacts();
  document
    .querySelectorAll("[data-task]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          showTask(b.dataset.task).catch((e) => toast(e.message))),
    );
  document
    .querySelector("#create-backup")
    ?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      toast("Đang sao lưu PostgreSQL…");
      await act(() => api("/backups", { method: "POST" }));
    });
  document
    .querySelectorAll("[data-go]")
    .forEach((b) => (b.onclick = () => (location.hash = b.dataset.go)));
  document
    .querySelectorAll("[data-agent]")
    .forEach((b) => (b.onclick = () => showAgent(b.dataset.agent)));
  document.querySelectorAll("[data-check]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        await act(() =>
          api("/agents/" + b.dataset.check + "/check", { method: "POST" }),
        );
      }),
  );
  document
    .querySelectorAll("[data-zalo],[data-zalo-manage]")
    .forEach(
      (b) => (b.onclick = () => showZalo().catch((e) => toast(e.message))),
    );
  document
    .querySelectorAll("[data-telegram]")
    .forEach(
      (b) => (b.onclick = () => showTelegram().catch((e) => toast(e.message))),
    );
  document.querySelectorAll("[data-telegram-link]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await showTelegram();
          modal.querySelector("#telegram-link")?.click();
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  document.querySelectorAll("[data-telegram-test]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await showTelegram();
          modal.querySelector("#telegram-test")?.click();
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  document.querySelectorAll("[data-calendar-shift]").forEach(
    (b) =>
      (b.onclick = () => {
        calendarMonth = new Date(
          calendarMonth.getFullYear(),
          calendarMonth.getMonth() + Number(b.dataset.calendarShift),
          1,
        );
        void render();
      }),
  );
  document
    .querySelector("[data-calendar-today]")
    ?.addEventListener("click", () => {
      calendarMonth = new Date();
      void render();
    });
  document
    .querySelectorAll("[data-calendar-add]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          calendarDialog(
            null,
            calendarTargetsData,
            b.dataset.calendarAdd || "",
          )),
    );
  document.querySelectorAll("[data-calendar-edit]").forEach(
    (b) =>
      (b.onclick = () => {
        const item = calendarData.jobs.find(
          (j) => j.id === b.dataset.calendarEdit,
        );
        if (item) calendarDialog(item, calendarTargetsData);
      }),
  );
  document.querySelectorAll("[data-reconnect-zalo]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api("/zalo/reconnect", { method: "POST" });
          toast("Đang kết nối lại bằng phiên đã lưu…");
          await render();
        } catch (err) {
          toast(err.message);
          b.disabled = false;
        }
      }),
  );
  document
    .querySelector("[data-policy-advanced]")
    ?.addEventListener("click", () =>
      showPolicy().catch((e) => toast(e.message)),
    );
  document
    .querySelectorAll("[data-policy],[data-dm-jump]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          document
            .querySelector("#dm-contacts")
            ?.scrollIntoView({ behavior: "smooth", block: "start" })),
    );
  document.querySelectorAll("[data-resolve]").forEach(
    (b) =>
      (b.onclick = () => {
        if (
          !confirm(
            b.dataset.action === "retry"
              ? "Anh đã kiểm tra tác động của lần chạy trước và đồng ý chạy lại?"
              : "Xác nhận đã đối soát và kết thúc công việc này?",
          )
        )
          return;
        void act(() =>
          api("/tasks/" + b.dataset.resolve + "/resolve", {
            method: "POST",
            body: { action: b.dataset.action },
          }),
        );
      }),
  );
  document.querySelector("#routing-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    void act(() =>
      api("/routing", {
        method: "PUT",
        body: {
          preferred: f.get("preferred"),
          failureThreshold: Number(f.get("failureThreshold")),
          recoverySeconds: Number(f.get("recoverySeconds")),
          paused: f.has("paused"),
        },
      }),
    );
  });
  document.querySelector("#new-chat")?.addEventListener("click", () => {
    activeConversation = null;
    lastMessages = "";
    void render();
  });
  document.querySelectorAll("[data-conversation]").forEach(
    (b) =>
      (b.onclick = () => {
        activeConversation = b.dataset.conversation;
        lastMessages = "";
        void render();
      }),
  );
  document
    .querySelector("#chat-form")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = e.target.querySelector("textarea"),
        button = e.target.querySelector("button");
      button.disabled = true;
      try {
        const data = await api("/chat", {
          method: "POST",
          body: {
            content: input.value,
            ...(activeConversation
              ? { conversationId: activeConversation }
              : {}),
          },
        });
        activeConversation = data.conversationId;
        lastMessages = "";
        await render();
        toast("Đã lưu yêu cầu vào hàng đợi");
      } catch (err) {
        toast(err.message);
        button.disabled = false;
      }
    });
  document.querySelector("#memory-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    void act(() =>
      api("/memories", {
        method: "POST",
        body: {
          conversationId: f.get("conversationId"),
          content: f.get("content"),
        },
      }),
    );
  });
  document.querySelectorAll("[data-delete-memory]").forEach(
    (b) =>
      (b.onclick = () => {
        if (confirm("Xóa thông tin này khỏi bộ nhớ chung?"))
          void act(() =>
            api("/memories/" + b.dataset.deleteMemory, { method: "DELETE" }),
          );
      }),
  );
}
async function render({ background = false } = {}) {
  const requestedHash = location.hash;
  const version = ++renderVersion;
  try {
    const nextSnapshot = await api("/overview");
    if (version !== renderVersion || requestedHash !== location.hash) return;
    snapshot = nextSnapshot;
    page = location.hash.slice(1) || "overview";
    if (!names[page]) page = "overview";
    // Build the complete next page before touching the mounted document.
    // In particular, contacts must finish loading before a live refresh commits.
    let html = "";
    if (page === "overview") html = overview();
    if (page === "channels") {
      dmContactsData = await api("/zalo/contacts");
      html = channels();
    }
    if (page === "calendar") {
      const [data, targets] = await Promise.all([
        api("/calendar"),
        api("/calendar/targets"),
      ]);
      calendarData = data;
      calendarTargetsData = (targets.targets || []).filter((t) => t.allowed);
      html = calendarPage(data, calendarTargetsData);
    }
    if (page === "connections") {
      html = connections();
    }
    if (page === "conversations") html = await conversations();
    if (page === "tasks")
      html =
        heading(
          "Công việc & nhiệm vụ",
          "Theo dõi lượt chạy, nhiệm vụ con và xử lý các trường hợp cần đối soát.",
        ) +
        `<section class="card"><div class="card-head"><h2>Hàng đợi và lịch sử thực thi</h2>${badge(snapshot.routing.paused ? "review" : "online", snapshot.routing.paused ? "Tạm dừng" : "Đang bật")}</div>${taskTable(await api("/tasks"))}</section>`;
    if (page === "memory") html = await memories();
    if (page === "bcp") html = bcp();
    if (page === "events")
      html =
        heading(
          "Nhật ký hệ thống",
          "Các thay đổi kết nối, điều phối và trạng thái thực thi.",
        ) +
        `<section class="card"><div class="card-body">${eventList(await api("/events"))}</div></section>`;
    if (version !== renderVersion || requestedHash !== location.hash) return;
    // A dialog or text field may have gained focus while requests were in flight.
    if (
      background &&
      (modal.open || document.activeElement?.matches("input,textarea,select"))
    )
      return;
    const samePage =
      renderedPage === page && !!document.querySelector("#content");
    // Capture at commit time, so scrolling during a slow request is respected.
    const position = { left: window.scrollX, top: window.scrollY };
    const tableScrolls = samePage
      ? [...document.querySelectorAll("#content .table-wrap")].map(
          (el) => el.scrollLeft,
        )
      : [];
    if (!samePage) shell();
    document.querySelector("#content").innerHTML = html;
    renderedPage = page;
    bind();
    if (samePage) {
      document.querySelectorAll("#content .table-wrap").forEach((el, i) => {
        el.scrollLeft = tableScrolls[i] || 0;
      });
      window.scrollTo({ ...position, behavior: "instant" });
    } else window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    if (page === "conversations") {
      lastMessages = "";
      await updateMessages();
    }
    if (page === "bcp") {
      await loadOutbox();
      const backups = await api("/backups");
      if (version !== renderVersion || page !== "bcp") return;
      document.querySelector("#backups").innerHTML = backups.length
        ? backups
            .map(
              (b) =>
                `<div class="health-row"><span class="mono">${escape(b.name)}</span><span class="small muted">${Math.ceil(b.size / 1024)} KB · ${when(b.createdAt)}</span></div>`,
            )
            .join("")
        : empty("Chưa có backup");
    }
  } catch (err) {
    if (version === renderVersion && page !== "login") toast(err.message);
  }
}
window.addEventListener("hashchange", () => void render());
setInterval(async () => {
  if (
    refreshing ||
    page === "login" ||
    document.activeElement?.id === "dm-contact-search"
  )
    return;
  refreshing = true;
  try {
    if (modal.open && modal.querySelector("#qr-state")) return;
    if (page === "conversations") await updateMessages();
    else if (
      !modal.open &&
      [
        "overview",
        "tasks",
        "events",
        "connections",
        "channels",
        "calendar",
      ].includes(page)
    )
      await render({ background: true });
  } catch {
  } finally {
    refreshing = false;
  }
}, 5000);
const session = await api("/session");
if (session.authenticated) await render();
else login();

async function renderGroupBrain(base, query, target) {
  const panel = modal.querySelector("#brain-view");
  if (!panel) return;
  const refresh = () => renderGroupBrain(base, query, target);
  const mutate = async (path, method, body) => {
    try {
      await api(base + "/brain/" + path, {
        method,
        body: { accountId: target.accountId, ...body },
      });
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  modal.querySelector("#brain-reload").onclick = refresh;
  modal.querySelector("#brain-summarize").onclick = () =>
    mutate("summarize", "POST", {});
  modal.querySelector("#brain-rebuild").onclick = () =>
    mutate("rebuild", "POST", {});
  try {
    const data = await api(base + "/brain" + query);
    const statuses = {
      proposed: "AI trích xuất · chưa xác nhận",
      confirmed: "Đã xác nhận",
      disputed: "Cần xác minh",
      rejected: "Đã bác bỏ",
      superseded: "Đã thay thế",
    };
    panel.innerHTML = `<p class="small">Đã ghi nhận: ${escape(data.counts.total)} · Chưa tổng hợp: ${escape(data.counts.pending)} · Nhiễu: ${escape(data.counts.noise)}</p><p class="small">Tổng hợp gần nhất: ${when(data.job?.last_success_at)} · Lần tới: ${when(data.job?.next_run_at)} · ${data.job?.lease ? "Đang tổng hợp" : "Đang chờ"}</p>${data.job?.last_error ? `<p class="note warn">${escape(data.job.last_error)}</p>` : ""}
    ${data.overview ? `<h3>Tổng hợp cấp nhóm · v${escape(data.overview.revision)}</h3><p class="small muted">AI tổng hợp từ các topic được cung cấp, chưa phải xác nhận của nhóm.</p><pre class="profile-preview">${escape(data.overview.summary)}</pre>` : ""}<h3>Topic</h3>${data.topics.map((t) => `<details><summary>${escape(t.title)} · ${escape(t.status)} · v${escape(t.revision)}</summary><p class="small">Bản tổng hợp AI, cần đối chiếu bằng chứng.</p><pre class="profile-preview">${escape(t.summary)}</pre><button type="button" data-topic-edit="${escape(t.id)}">Sửa tên / trạng thái</button><button type="button" data-topic-merge="${escape(t.id)}">Gộp topic</button><button type="button" data-topic-split="${escape(t.id)}">Tách topic</button><p class="small mono">ID: ${escape(t.id)}</p></details>`).join("") || "<p>Chưa có topic.</p>"}
    <h3>Bộ nhớ và bằng chứng</h3>${data.facts.map((f) => `<details><summary>${escape(f.category)} · ${escape(statuses[f.status])}: ${escape(f.content)}</summary>${f.conflicts?.length ? `<p class="note warn">Mâu thuẫn cần xác minh với: ${f.conflicts.map(escape).join(", ")}</p>` : ""}<p class="small">Hiệu lực từ ${when(f.valid_from)}${f.valid_to ? " đến " + when(f.valid_to) : ""}</p>${f.sources.map((r) => `<blockquote><strong>${escape(r.sender)}</strong> · ${when(r.at)}<p>${escape(r.content)}</p><small class="mono">${escape(r.id)}</small></blockquote>`).join("")}${!f.valid_to ? `<button type="button" data-fact-confirm="${escape(f.id)}">Xác nhận</button><button type="button" data-fact-reject="${escape(f.id)}">Bác bỏ</button><button type="button" data-fact-replace="${escape(f.id)}">Xác nhận và thay bản cũ</button>` : ""}<p class="small mono">ID: ${escape(f.id)}</p></details>`).join("") || "<p>Chưa có bộ nhớ.</p>"}`;
    panel.insertAdjacentHTML(
      "beforeend",
      `<h3>Tin nguồn gần đây</h3>${data.records.map((r) => `<details><summary>${escape(r.sender_name)} · ${when(r.occurred_at)} · ${r.noise ? "Nhiễu" : "Giữ lại"}</summary><pre class="profile-preview">${escape(r.content)}</pre><p class="small mono">${escape(r.id)}</p><button type="button" data-record-id="${escape(r.id)}" data-record-noise="${r.noise ? "false" : "true"}">${r.noise ? "Giữ làm thông tin" : "Đánh dấu nhiễu"}</button></details>`).join("")}`,
    );
    panel.querySelectorAll("[data-record-id]").forEach(
      (b) =>
        (b.onclick = () =>
          mutate("records/" + b.dataset.recordId, "PUT", {
            noise: b.dataset.recordNoise === "true",
          })),
    );
    panel
      .querySelectorAll(
        "[data-fact-confirm],[data-fact-reject],[data-fact-replace]",
      )
      .forEach(
        (b) =>
          (b.onclick = async () => {
            const id =
              b.dataset.factConfirm ||
              b.dataset.factReject ||
              b.dataset.factReplace;
            const replacement = b.dataset.factReplace
              ? prompt("ID bộ nhớ cũ cần thay thế trong cùng topic:")
              : undefined;
            if (b.dataset.factReplace && !replacement) return;
            await mutate("facts/" + id, "PUT", {
              status: b.dataset.factReject ? "rejected" : "confirmed",
              replacement,
            });
          }),
      );
    panel.querySelectorAll("[data-topic-edit]").forEach(
      (b) =>
        (b.onclick = async () => {
          const topic = data.topics.find((t) => t.id === b.dataset.topicEdit);
          const title = prompt("Tên topic:", topic.title);
          if (!title) return;
          const status = prompt("Trạng thái: active hoặc closed", topic.status);
          if (!status) return;
          await mutate("topics/" + topic.id, "PUT", { title, status });
        }),
    );
    panel.querySelectorAll("[data-topic-merge]").forEach(
      (b) =>
        (b.onclick = async () => {
          const targetId = prompt("ID topic đích trong nhóm này:");
          if (targetId)
            await mutate("topics/" + b.dataset.topicMerge + "/merge", "POST", {
              targetId,
            });
        }),
    );
    panel.querySelectorAll("[data-topic-split]").forEach(
      (b) =>
        (b.onclick = async () => {
          const title = prompt("Tên topic mới:");
          if (!title) return;
          const ids = prompt(
            "ID các tin nguồn cần tách, phân cách bằng dấu phẩy:",
          );
          if (!ids) return;
          await mutate("topics/" + b.dataset.topicSplit + "/split", "POST", {
            title,
            recordIds: ids.split(",").map((x) => x.trim()),
          });
        }),
    );
  } catch (error) {
    panel.textContent = error.message;
  }
}
