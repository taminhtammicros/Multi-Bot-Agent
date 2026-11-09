-- Multi-platform members extend the existing Zalo/Telegram room without replaying its traffic.
CREATE TABLE IF NOT EXISTS bridge_connections (
 platform text PRIMARY KEY CHECK(platform IN ('discord','whatsapp','viber','teams_personal')),
 config_cipher text NOT NULL, account_id text NOT NULL,
 checked_at timestamptz, received_at timestamptz, error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bridge_members (
 id uuid PRIMARY KEY, bridge_id uuid NOT NULL REFERENCES channel_bridges(id),
 platform text NOT NULL CHECK(platform IN ('discord','whatsapp','viber','teams_personal')),
 account_id text NOT NULL, chat_id text NOT NULL, title text NOT NULL,
 receive boolean NOT NULL DEFAULT true, send boolean NOT NULL DEFAULT true,
 images boolean NOT NULL DEFAULT true, files boolean NOT NULL DEFAULT true,
 enabled boolean NOT NULL DEFAULT false, activated_at timestamptz,
 revision int NOT NULL DEFAULT 1, cursor text, checked_at timestamptz, error text,
 next_poll_at timestamptz NOT NULL DEFAULT now(), next_send_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(platform,account_id,chat_id)
);
CREATE TABLE IF NOT EXISTS bridge_deliveries (
 id uuid PRIMARY KEY, seq bigserial UNIQUE, bridge_id uuid NOT NULL REFERENCES channel_bridges(id),
 source_platform text NOT NULL, source_account_id text NOT NULL, source_chat_id text NOT NULL,
 source_message_id text NOT NULL, source_at timestamptz NOT NULL,
 source_member uuid, source_revision int, target_member uuid,
 target_platform text NOT NULL, target_account_id text NOT NULL, target_chat_id text NOT NULL,
 target_revision int, activation_at timestamptz NOT NULL, payload_cipher text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','preparing','sending','sent','review','failed','cancelled')),
 attempts int NOT NULL DEFAULT 0, receipts jsonb NOT NULL DEFAULT '[]', error text,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(bridge_id,source_platform,source_account_id,source_chat_id,source_message_id,target_platform,target_account_id,target_chat_id)
);
CREATE INDEX IF NOT EXISTS bridge_deliveries_pending ON bridge_deliveries(status,next_attempt_at,seq);
CREATE TABLE IF NOT EXISTS bridge_contacts (
 platform text NOT NULL,account_id text NOT NULL,chat_id text NOT NULL,title text NOT NULL,
 last_inbound timestamptz NOT NULL DEFAULT now(),subscribed boolean NOT NULL DEFAULT true,
 PRIMARY KEY(platform,account_id,chat_id)
);
CREATE TABLE IF NOT EXISTS bridge_media (
 token text PRIMARY KEY, payload_cipher text NOT NULL, name text NOT NULL, mime text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour'
);

ALTER TABLE bridge_contacts ADD COLUMN IF NOT EXISTS chat_kind text;
ALTER TABLE bridge_contacts ADD COLUMN IF NOT EXISTS discovered_at timestamptz;
