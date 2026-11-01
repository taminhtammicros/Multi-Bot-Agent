import type { SendMessageQuote, MessageContent } from "zca-js";
import type { ChatProfile } from "./chat-profiles.js";
import { splitFormatted } from "./zalo-format.js";

const numericId = (v: unknown) => typeof v === "string" && /^\d{1,30}$/.test(v);
/** Capture only metadata for admitted text messages, in the same transaction as the task. */
export function captureReplyTarget(data: any): Record<string, unknown> {
  const senderId = String(data.uidFrom || "");
  if (!numericId(senderId)) return {};
  const senderName = Array.from(String(data.dName || senderId))
    .slice(0, 120)
    .join("")
    .replace(/[\r\n]/g, " ");
  const target: Record<string, unknown> = { senderId, senderName };
  const msgId = String(data.msgId || ""),
    cliMsgId = String(data.cliMsgId || ""),
    ts = String(data.ts || "");
  if (numericId(msgId) && numericId(cliMsgId) && numericId(ts)) {
    // receive() admits text only, so webchat quote is supported by the SDK.
    target.quote = {
      uidFrom: senderId,
      msgId,
      cliMsgId,
      ts,
      msgType: "webchat",
      ttl: Number.isFinite(data.ttl) ? data.ttl : 0,
      propertyExt: data.propertyExt
        ? {
            color: Number(data.propertyExt.color) || 0,
            size: Number(data.propertyExt.size) || 0,
            type: Number(data.propertyExt.type) || 0,
            subType: Number(data.propertyExt.subType) || 0,
            ext: String(data.propertyExt.ext || "").slice(0, 4096),
          }
        : undefined,
    };
  }
  return target;
}

export function formatReply(
  text: string,
  profile: ChatProfile,
  metadata: any,
  originalContent: string,
  group: boolean,
): (string | MessageContent)[] {
  const mode = profile.replyTarget;
  const stored = metadata?.quote;
  const quote: SendMessageQuote | undefined =
    (mode === "reply" || mode === "both" || (!group && mode === "tag")) &&
    stored &&
    numericId(stored.uidFrom) &&
    stored.uidFrom === metadata.senderId &&
    numericId(stored.msgId) &&
    numericId(stored.cliMsgId) &&
    numericId(stored.ts)
      ? { ...stored, content: originalContent, msgType: "webchat" }
      : undefined;
  // Missing quote metadata (e.g. older messages): use a native group mention,
  // never invent a message ID or attach a different user's question.
  const tag =
    group &&
    mode !== "none" &&
    numericId(metadata?.senderId) &&
    (mode === "tag" || mode === "both" || !quote);
  const name = Array.from(
    String(metadata?.senderName || metadata?.senderId || ""),
  )
    .slice(0, 120)
    .join("")
    .replace(/[\r\n]/g, " ");
  const prefix = tag ? "@" + name + "\n" : "";
  return splitFormatted(text, profile, 1800 - prefix.length).map(
    (part, index) => {
      const lead = index === 0 ? prefix : "";
      if (!quote && !lead && profile.presentation === "plain") return part.msg;
      return {
        msg: lead + part.msg,
        ...(profile.presentation === "color"
          ? {
              styles: part.styles.map((s) => ({
                ...s,
                start: s.start + lead.length,
              })),
            }
          : {}),
        ...(quote ? { quote } : {}),
        ...(lead
          ? {
              mentions: [
                { uid: metadata.senderId, pos: 0, len: lead.length - 1 },
              ],
            }
          : {}),
      };
    },
  );
}
