CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
 id text PRIMARY KEY CHECK(id IN ('hermes','openclaw')), enabled boolean NOT NULL DEFAULT false,
 base_url text NOT NULL, model text NOT NULL, secret text NOT NULL DEFAULT '',
 health text NOT NULL DEFAULT 'unconfigured', failures int NOT NULL DEFAULT 0,
 last_checked timestamptz, last_ok timestamptz, latency_ms int, error text
);
INSERT INTO agents(id,base_url,model) VALUES ('hermes','http://127.0.0.1:8642/v1','hermes-agent'),('openclaw','http://127.0.0.1:18789/v1','openclaw') ON CONFLICT DO NOTHING;
INSERT INTO settings VALUES ('routing','{"preferred":"auto","failureThreshold":3,"recoverySeconds":60,"paused":false}'),('zalo','{"allowUsers":[],"allowGroups":[],"groupsEnabled":false}'),('telegram','{}') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS conversations(id text PRIMARY KEY, title text NOT NULL, source text NOT NULL, thread_id text, thread_type int, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS messages(id uuid PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id), role text NOT NULL, content text NOT NULL, agent text, external_id text UNIQUE, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS tasks(id uuid PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id), message_id uuid NOT NULL UNIQUE REFERENCES messages(id), status text NOT NULL DEFAULT 'queued', agent text, result text, error text, parent_id uuid REFERENCES tasks(id), generation bigint, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS runs(id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), agent text NOT NULL, status text NOT NULL, error text, created_at timestamptz DEFAULT now(), finished_at timestamptz);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'main';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS request_bytes int;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS response_bytes int;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS input_tokens int;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS output_tokens int;
UPDATE runs r SET phase='delegate' FROM tasks t WHERE t.id=r.task_id AND t.parent_id IS NOT NULL AND r.phase='main';
CREATE TABLE IF NOT EXISTS memories(id uuid PRIMARY KEY, conversation_id text REFERENCES conversations(id), content text NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS events(id bigserial PRIMARY KEY, kind text NOT NULL, message text NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS outbox(id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES tasks(id), conversation_id text NOT NULL REFERENCES conversations(id), content text NOT NULL, status text NOT NULL DEFAULT 'pending', error text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS leadership(id int PRIMARY KEY CHECK(id=1), agent text, generation bigint NOT NULL DEFAULT 0, changed_at timestamptz DEFAULT now());
INSERT INTO leadership(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
CREATE INDEX IF NOT EXISTS tasks_pending ON tasks(status,created_at);
CREATE INDEX IF NOT EXISTS tasks_conversation_status ON tasks(conversation_id,status);
CREATE INDEX IF NOT EXISTS outbox_conversation_status ON outbox(conversation_id,status);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS zalo_reply jsonb;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS healthy_since timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS run_cooldown_until timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_run_error text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_run_ms int;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_run_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS run_failures int NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'answer';
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_task_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS outbox_task_kind ON outbox(task_id,kind);
WITH recent AS (
 SELECT DISTINCT ON(agent) agent,error,created_at,finished_at FROM runs
 WHERE finished_at IS NOT NULL ORDER BY agent,created_at DESC
) UPDATE agents a SET last_run_error=r.error,last_run_at=r.finished_at,
 last_run_ms=GREATEST(0,LEAST(2147483647,extract(epoch FROM (r.finished_at-r.created_at))*1000))::int
FROM recent r WHERE a.id=r.agent AND a.last_run_at IS NULL;

CREATE TABLE IF NOT EXISTS zalo_contacts (
 account_id text NOT NULL,
 uid text NOT NULL,
 display_name text NOT NULL DEFAULT '',
 first_seen timestamptz NOT NULL DEFAULT now(),
 last_seen timestamptz NOT NULL DEFAULT now(),
 message_count bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(account_id,uid)
);
CREATE INDEX IF NOT EXISTS zalo_contacts_seen ON zalo_contacts(account_id,last_seen DESC);

CREATE TABLE IF NOT EXISTS zalo_groups (
 account_id text NOT NULL, group_id text NOT NULL,
 display_name text NOT NULL DEFAULT '',
 first_seen timestamptz NOT NULL DEFAULT now(),
 observed_at timestamptz NOT NULL DEFAULT now(),
 last_seen timestamptz,
 message_count bigint NOT NULL DEFAULT 0,
 member_count int,
 PRIMARY KEY(account_id,group_id)
);
CREATE INDEX IF NOT EXISTS zalo_groups_seen ON zalo_groups(account_id,observed_at DESC);

CREATE TABLE IF NOT EXISTS zalo_reply_rules (
 account_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('dm','group')),
 uid text NOT NULL,mode text NOT NULL CHECK(mode IN ('mention','silent','all')),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,kind,uid)
);
ALTER TABLE zalo_contacts ALTER COLUMN last_seen DROP NOT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS bot_mentioned boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_account_id text;

CREATE TABLE IF NOT EXISTS chat_profiles (
 account_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('dm','group')),uid text NOT NULL,
 config jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,kind,uid)
);
CREATE TABLE IF NOT EXISTS owner_actions (
 id uuid PRIMARY KEY,
 code text NOT NULL UNIQUE CHECK(code ~ '^[A-F0-9]{10}$'),
 account_id text NOT NULL,
 owner_uid text NOT NULL,
 conversation_id text NOT NULL REFERENCES conversations(id),
 request_task_id uuid NOT NULL REFERENCES tasks(id),
 execution_task_id uuid REFERENCES tasks(id),
 request_text text NOT NULL,
 status text NOT NULL DEFAULT 'awaiting_confirmation'
  CHECK(status IN ('awaiting_confirmation','executing','completed','cancelled','review')),
 result text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 confirmed_at timestamptz
);
CREATE INDEX IF NOT EXISTS owner_actions_scope ON owner_actions(account_id,owner_uid,conversation_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS owner_group_sends (
 id uuid PRIMARY KEY,
 owner_action_id uuid NOT NULL UNIQUE REFERENCES owner_actions(id),
 account_id text NOT NULL,
 owner_uid text NOT NULL,
 group_id text NOT NULL,
 conversation_id text NOT NULL REFERENCES conversations(id),
 task_id uuid NOT NULL REFERENCES tasks(id),
 content text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','review','cancelled')),
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS owner_group_sends_pending ON owner_group_sends(status,created_at);
CREATE TABLE IF NOT EXISTS telegram_link_codes (
 code_hash text PRIMARY KEY,
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 chat_id text
);
CREATE TABLE IF NOT EXISTS chat_sources (
 id uuid PRIMARY KEY,account_id text NOT NULL,kind text NOT NULL,uid text NOT NULL,
 source_type text NOT NULL,name text NOT NULL,locator text NOT NULL DEFAULT '',
 content text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'ready',error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_sources_scope ON chat_sources(account_id,kind,uid);
CREATE TABLE IF NOT EXISTS zalo_announcements (
 id uuid PRIMARY KEY,account_id text NOT NULL,group_id text NOT NULL,event_key text NOT NULL UNIQUE,
 content text NOT NULL,mentions jsonb NOT NULL DEFAULT '[]',status text NOT NULL DEFAULT 'pending',
 error text,created_at timestamptz NOT NULL DEFAULT now()
);
