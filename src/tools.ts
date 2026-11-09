import { setting, query } from "./db.js";

export const toolDefaults = {
  image_reading: true,
  file_creation: true,
  poll_creation: true,
  scheduled_tasks: true,
  knowledge_sources: true,
} as const;

export type BotToolId = keyof typeof toolDefaults;
export type BotToolSettings = Record<BotToolId, boolean>;

export async function getBotToolSettings(): Promise<BotToolSettings> {
  const saved = await setting<Partial<BotToolSettings>>("bot_tools");
  return { ...toolDefaults, ...(saved || {}) };
}

export async function botToolEnabled(id: BotToolId) {
  return (await getBotToolSettings())[id];
}

export async function setBotToolEnabled(id: BotToolId, enabled: boolean) {
  const settings = await getBotToolSettings();
  settings[id] = enabled;
  await query("INSERT INTO settings(key,value) VALUES('bot_tools',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [settings]);
  return settings;
}
