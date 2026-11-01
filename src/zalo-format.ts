import { TextStyle, type Mention } from "zca-js";
import type { ChatProfile } from "./chat-profiles.js";
export function stripEmoji(text: string) {
  return text
    .replace(/[0-9#*]\uFE0F?\u20E3/g, "")
    .replace(
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0F]/gu,
      "",
    );
}
export function styledText(
  input: string,
  p: Pick<ChatProfile, "presentation" | "emoji">,
) {
  const raw = p.emoji ? input : stripEmoji(input);
  let msg = "",
    position = 0;
  const styles: { start: number; len: number; st: TextStyle }[] = [];
  const regex = /\[(GREEN|RED|YELLOW)\]([\s\S]*?)\[\/\1\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw))) {
    msg += raw.slice(position, match.index);
    const start = msg.length;
    msg += match[2];
    if (p.presentation === "color")
      styles.push({
        start,
        len: match[2].length,
        st: {
          GREEN: TextStyle.Green,
          RED: TextStyle.Red,
          YELLOW: TextStyle.Yellow,
        }[match[1] as "GREEN" | "RED" | "YELLOW"],
      });
    position = regex.lastIndex;
  }
  msg += raw.slice(position);
  msg = msg.replace(/\[\/?(?:GREEN|RED|YELLOW)\]/g, "");
  if (p.presentation === "color" && !styles.length) {
    let offset = 0;
    for (const line of msg.split("\n")) {
      const st = /cảnh báo|nguy cơ|không được/i.test(line)
        ? TextStyle.Red
        : /lưu ý|chưa xác minh|cần kiểm tra/i.test(line)
          ? TextStyle.Yellow
          : offset === 0
            ? TextStyle.Green
            : null;
      if (st && line.trim())
        styles.push({ start: offset, len: line.length, st });
      offset += line.length + 1;
    }
  }
  return { msg, styles };
}
export function splitFormatted(
  input: string,
  p: Pick<ChatProfile, "presentation" | "emoji">,
  limit = 1800,
) {
  const full = styledText(input, p),
    parts: { msg: string; styles: typeof full.styles }[] = [];
  let offset = 0;
  while (offset < full.msg.length) {
    let end = Math.min(offset + limit, full.msg.length);
    if (end < full.msg.length && /[\uD800-\uDBFF]/.test(full.msg[end - 1]))
      end--;
    parts.push({
      msg: full.msg.slice(offset, end),
      styles: full.styles.flatMap((s) => {
        const start = Math.max(s.start, offset),
          stop = Math.min(s.start + s.len, end);
        return stop > start
          ? [{ ...s, start: start - offset, len: stop - start }]
          : [];
      }),
    });
    offset = end;
  }
  return parts;
}
export function welcomeMessage(
  template: string,
  members: { id: string; dName: string }[],
  groupName: string,
) {
  const unique = [
    ...new Map(
      members.filter((m) => /^\d{1,30}$/.test(m.id)).map((m) => [m.id, m]),
    ).values(),
  ];
  const names = unique.map((m) => "@" + (m.dName || m.id));
  const tags = names.join(" ");
  const content = template.replace(/\{group\}/g, groupName);
  const at = content.indexOf("{members}");
  const msg =
    at >= 0
      ? content.slice(0, at) + tags + content.slice(at + 9)
      : tags + " " + content;
  const start = at >= 0 ? at : 0;
  let offset = start;
  const mentions: Mention[] = unique.map((m, i) => {
    const result = { uid: m.id, pos: offset, len: names[i].length };
    offset += names[i].length + 1;
    return result;
  });
  return { msg, mentions };
}
export function splitMentioned(
  input: { msg: string; mentions: Mention[] },
  limit = 1800,
) {
  const parts: (typeof input)[] = [];
  let offset = 0;
  while (offset < input.msg.length) {
    let end = Math.min(offset + limit, input.msg.length);
    const crossing = input.mentions.find(
      (m) => m.pos < end && m.pos + m.len > end,
    );
    if (crossing) end = crossing.pos;
    if (end <= offset) throw new Error("Tên được tag vượt giới hạn tin nhắn");
    if (end < input.msg.length && /[\uD800-\uDBFF]/.test(input.msg[end - 1]))
      end--;
    parts.push({
      msg: input.msg.slice(offset, end),
      mentions: input.mentions
        .filter((m) => m.pos >= offset && m.pos + m.len <= end)
        .map((m) => ({ ...m, pos: m.pos - offset })),
    });
    offset = end;
  }
  return parts;
}
