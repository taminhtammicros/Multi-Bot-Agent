import { groupScope } from "./group-brain.js";
import { randomUUID } from "node:crypto";
import { enqueue } from "./engine.js";
import { event, pool, query } from "./db.js";
import { getZaloPolicy } from "./zalo-policy.js";
import { botToolEnabled } from "./tools.js";

export type CalendarInput = {
  title: string;
  prompt: string;
  threadId: string;
  threadType: 0 | 1;
  targetName: string;
  runAt: string;
  runTimes?: string[];
  recurrence: "once" | "daily" | "weekly";
};

function instant(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}:00+07:00`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const vietnamDateKey = (date: Date) =>
  new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

function addDateDays(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function instantAt(dateKey: string, time: string) {
  return new Date(`${dateKey}T${time}:00+07:00`);
}

function nextOccurrence(
  startDate: string,
  recurrence: CalendarInput["recurrence"],
  runTimes: string[],
  after: Date,
) {
  const firstDate = startDate < vietnamDateKey(after) ? vietnamDateKey(after) : startDate;
  for (let offset = 0; offset <= 14; offset++) {
    const dateKey = addDateDays(firstDate, offset);
    if (
      recurrence === "weekly" &&
      Math.round(
        (Date.parse(`${dateKey}T12:00:00Z`) -
          Date.parse(`${startDate}T12:00:00Z`)) /
          86400000,
      ) % 7 !== 0
    )
      continue;
    for (const time of runTimes) {
      const candidate = instantAt(dateKey, time);
      if (candidate.getTime() > after.getTime() + 15000) return candidate;
    }
  }
  return null;
}

async function permitted(
  accountId: string,
  threadId: string,
  threadType: 0 | 1,
) {
  const policy = await getZaloPolicy(accountId);
  if (threadType === 1)
    return Boolean(
      policy?.groupsEnabled && policy.allowGroups?.includes(threadId),
    );
  return Boolean(policy?.allowUsers?.includes(threadId));
}

export async function calendarTargets(accountId: string | null) {
  if (!accountId) return { targets: [], groupsEnabled: false };
  const policy = await getZaloPolicy(accountId);
  const [users, groups] = await Promise.all([
    query(
      "SELECT uid,display_name FROM zalo_contacts WHERE account_id=$1 ORDER BY display_name,uid",
      [accountId],
    ),
    query(
      "SELECT group_id AS uid,display_name FROM zalo_groups WHERE account_id=$1 ORDER BY display_name,group_id",
      [accountId],
    ),
  ]);
  const byId = new Map<string, any>();
  for (const uid of policy?.allowUsers || [])
    byId.set(`0:${uid}`, { uid, threadType: 0, name: uid, allowed: true });
  for (const uid of policy?.allowGroups || [])
    byId.set(`1:${uid}`, { uid, threadType: 1, name: uid, allowed: true });
  for (const row of users.rows) {
    const item = byId.get(`0:${row.uid}`);
    if (item) item.name = row.display_name || item.name;
  }
  for (const row of groups.rows) {
    const item = byId.get(`1:${row.uid}`);
    if (item) item.name = row.display_name || item.name;
  }
  return {
    targets: [...byId.values()].map((x) => ({
      ...x,
      allowed: x.threadType === 0 || Boolean(policy?.groupsEnabled),
    })),
    groupsEnabled: Boolean(policy?.groupsEnabled),
  };
}

export async function listCalendar() {
  return (
    await query(
      `SELECT j.*,COALESCE(NULLIF(CASE WHEN j.thread_type=1 THEN g.display_name ELSE c.display_name END,''),j.thread_id) AS target_name
     FROM calendar_jobs j
     LEFT JOIN zalo_contacts c ON j.thread_type=0 AND c.account_id=j.account_id AND c.uid=j.thread_id
     LEFT JOIN zalo_groups g ON j.thread_type=1 AND g.account_id=j.account_id AND g.group_id=j.thread_id
     ORDER BY j.next_run_at,j.created_at DESC`,
    )
  ).rows;
}

export async function saveCalendar(
  input: CalendarInput,
  accountId: string,
  id?: string,
) {
  const requested = instant(input.runAt);
  const times = input.recurrence === "once"
    ? [input.runAt.slice(11)]
    : [...new Set(input.runTimes?.length ? input.runTimes : [input.runAt.slice(11)])].sort();
  if (
    !requested ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.runAt.slice(0, 10)) ||
    !times.length ||
    times.length > 24 ||
    times.some((time) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
  )
    throw Object.assign(
      new Error("Kiểm tra ngày bắt đầu và các khung giờ chạy (giờ Việt Nam)."),
      { statusCode: 400 },
    );
  const runAt = input.recurrence === "once"
    ? requested
    : nextOccurrence(input.runAt.slice(0, 10), input.recurrence, times, new Date());
  if (!runAt || runAt.getTime() <= Date.now() + 15000)
    throw Object.assign(
      new Error("Chọn ít nhất một khung giờ chạy trong tương lai (giờ Việt Nam)."),
      { statusCode: 400 },
    );
  if (!(await permitted(accountId, input.threadId, input.threadType)))
    throw Object.assign(
      new Error("Hội thoại chưa được cấp quyền trong trang Zalo & Telegram."),
      { statusCode: 403 },
    );
  const conversationId =
    input.threadType === 1
      ? groupScope({ accountId, groupId: input.threadId })
      : `zalo:${input.threadType}:${input.threadId}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO conversations(id,title,source,thread_id,thread_type) VALUES($1,$2,'zalo',$3,$4) ON CONFLICT(id) DO UPDATE SET title=CASE WHEN EXCLUDED.title='' THEN conversations.title ELSE EXCLUDED.title END,updated_at=now()",
      [conversationId, input.targetName, input.threadId, input.threadType],
    );
    if (id) {
      const changed = await client.query(
        `UPDATE calendar_jobs SET title=$3,prompt=$4,account_id=$5,thread_id=$6,thread_type=$7,conversation_id=$8,recurrence=$9,next_run_at=$10,run_times=$11,enabled=true,locked_at=null,updated_at=now()
         WHERE id=$1 AND account_id=$2 RETURNING id`,
        [
          id,
          accountId,
          input.title,
          input.prompt,
          accountId,
          input.threadId,
          input.threadType,
          conversationId,
          input.recurrence,
          runAt,
          times,
        ],
      );
      if (!changed.rowCount)
        throw Object.assign(new Error("Không tìm thấy lịch hẹn."), {
          statusCode: 404,
        });
    } else {
      await client.query(
        "INSERT INTO calendar_jobs(id,title,prompt,account_id,thread_id,thread_type,conversation_id,recurrence,next_run_at,run_times) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          randomUUID(),
          input.title,
          input.prompt,
          accountId,
          input.threadId,
          input.threadType,
          conversationId,
          input.recurrence,
          runAt,
          times,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await event("calendar", `${id ? "Cập nhật" : "Tạo"} lịch "${input.title}"`);
}

export async function removeCalendar(id: string) {
  const result = await query(
    "DELETE FROM calendar_jobs WHERE id=$1 RETURNING title",
    [id],
  );
  if (!result.rowCount)
    throw Object.assign(new Error("Không tìm thấy lịch hẹn."), {
      statusCode: 404,
    });
  await event("calendar", `Xóa lịch "${result.rows[0].title}"`);
}

export async function setCalendarEnabled(id: string, enabled: boolean) {
  const result = await query(
    "UPDATE calendar_jobs SET enabled=$2,locked_at=null,updated_at=now() WHERE id=$1 RETURNING title",
    [id, enabled],
  );
  if (!result.rowCount)
    throw Object.assign(new Error("Không tìm thấy lịch hẹn."), {
      statusCode: 404,
    });
  await event(
    "calendar",
    `${enabled ? "Bật" : "Tạm dừng"} lịch "${result.rows[0].title}"`,
  );
}

// Được gọi bởi worker; external_id duy nhất giúp khôi phục an toàn nếu dịch vụ dừng giữa hai bước.
export async function tickCalendar() {
  if (!(await botToolEnabled("scheduled_tasks"))) return;
  const due = await query(
    `UPDATE calendar_jobs SET locked_at=now() WHERE id=(
       SELECT id FROM calendar_jobs WHERE enabled AND next_run_at<=now()
         AND (locked_at IS NULL OR locked_at<now()-interval '2 minutes')
       ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 1
     ) RETURNING *`,
  );
  const job = due.rows[0];
  if (!job) return;
  try {
    const ok = await permitted(job.account_id, job.thread_id, job.thread_type);
    if (!ok) {
      await query(
        "UPDATE calendar_jobs SET enabled=false,locked_at=null,updated_at=now() WHERE id=$1",
        [job.id],
      );
      await event(
        "calendar",
        `Tạm dừng lịch "${job.title}": quyền Zalo đã bị thu hồi`,
      );
      return;
    }
    const scheduledAt = new Date(job.next_run_at);
    const taskId = await enqueue(
      job.conversation_id,
      job.title,
      "zalo",
      `Đây là lịch hẹn đã được chủ bot thiết lập. Hãy thực hiện yêu cầu sau và trả kết quả phù hợp với cuộc hội thoại: ${job.prompt}`,
      `calendar:${job.id}:${scheduledAt.toISOString()}`,
      job.thread_id,
      job.thread_type,
      { botMentioned: true, sourceAccountId: job.account_id },
    );
    if (job.recurrence === "once") {
      await query(
        "UPDATE calendar_jobs SET enabled=false,locked_at=null,last_run_at=now(),last_task_id=COALESCE($2,last_task_id),updated_at=now() WHERE id=$1",
        [job.id, taskId],
      );
    } else {
      const runTimes = Array.isArray(job.run_times) && job.run_times.length
        ? job.run_times
        : [new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false,
          }).format(scheduledAt)];
      const next = nextOccurrence(
        vietnamDateKey(scheduledAt),
        job.recurrence,
        runTimes,
        new Date(),
      );
      if (!next) throw new Error("Không tính được lần chạy kế tiếp của lịch.");
      await query(
        "UPDATE calendar_jobs SET next_run_at=$2,locked_at=null,last_run_at=now(),last_task_id=COALESCE($3,last_task_id),updated_at=now() WHERE id=$1",
        [job.id, next, taskId],
      );
    }
    await event(
      "calendar",
      `Đã đưa lịch "${job.title}" vào hàng đợi của Agents`,
    );
  } catch (error) {
    await query("UPDATE calendar_jobs SET locked_at=null WHERE id=$1", [
      job.id,
    ]).catch(() => {});
    throw error;
  }
}
