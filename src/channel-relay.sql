CREATE TABLE IF NOT EXISTS telegram_relay_groups (
 bot_id text NOT NULL, chat_id text NOT NULL, title text NOT NULL DEFAULT '', chat_type text NOT NULL,
 member_status text, can_read_all boolean, can_send boolean, can_send_media boolean,
 last_seen timestamptz NOT NULL DEFAULT now(), checked_at timestamptz,
 PRIMARY KEY(bot_id,chat_id)
);
CREATE TABLE IF NOT EXISTS channel_bridges (
 id uuid PRIMARY KEY, name text NOT NULL, zalo_account_id text NOT NULL, zalo_group_id text NOT NULL,
 telegram_bot_id text NOT NULL, telegram_chat_id text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('both','zalo_to_telegram','telegram_to_zalo')) DEFAULT 'both',
 media boolean NOT NULL DEFAULT true, enabled boolean NOT NULL DEFAULT false,
 activated_at timestamptz, archived_at timestamptz, next_send_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_bridge_zalo_unique ON channel_bridges(zalo_account_id,zalo_group_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channel_bridge_telegram_unique ON channel_bridges(telegram_bot_id,telegram_chat_id) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS channel_bridge_outbox (
 id uuid PRIMARY KEY, seq bigserial UNIQUE, bridge_id uuid NOT NULL REFERENCES channel_bridges(id),
 source_platform text NOT NULL CHECK(source_platform IN ('zalo','telegram')),
 source_account_id text NOT NULL, source_chat_id text NOT NULL, source_message_id text NOT NULL,
 source_at timestamptz NOT NULL, activation_at timestamptz NOT NULL,
 kind text NOT NULL CHECK(kind IN ('text','image','file')), payload_cipher text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','preparing','sending','sent','review','failed','cancelled')) DEFAULT 'queued',
 attempts int NOT NULL DEFAULT 0, receipts jsonb NOT NULL DEFAULT '[]', error text,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bridge_id,source_platform,source_account_id,source_chat_id,source_message_id)
);
CREATE INDEX IF NOT EXISTS channel_bridge_pending ON channel_bridge_outbox(status,next_attempt_at,seq);
