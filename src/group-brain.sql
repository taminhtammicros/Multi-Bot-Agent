-- Separate NOLOGIN role: SET LOCAL ROLE prevents the owner/superuser bypassing RLS.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zhub_group_scope') THEN
  CREATE ROLE zhub_group_scope NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zhub_group_scope' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolcanlogin)) THEN
  RAISE EXCEPTION 'Unsafe group scope role attributes';
 END IF;
 ALTER ROLE zhub_group_scope NOINHERIT;
 EXECUTE format('GRANT zhub_group_scope TO %I',current_user);
END $$;
CREATE TABLE IF NOT EXISTS group_scopes (
 scope text PRIMARY KEY, account_id text NOT NULL, group_id text NOT NULL,
 UNIQUE(account_id,group_id), CHECK(scope='zalo:'||account_id||':group:'||group_id)
);
CREATE TABLE IF NOT EXISTS group_records (
 scope text NOT NULL REFERENCES group_scopes(scope), id uuid NOT NULL,
 seq bigint GENERATED ALWAYS AS IDENTITY,
 external_id text NOT NULL, sender_id text NOT NULL, sender_name text NOT NULL,
 content text NOT NULL CHECK(length(content)<=100000),
 occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reply_external_id text, role text NOT NULL CHECK(role IN ('user','assistant','unsupported')),
 noise boolean NOT NULL DEFAULT false, filter_version int NOT NULL DEFAULT 1,
 classification text NOT NULL DEFAULT 'unclassified', processed_at timestamptz,
 PRIMARY KEY(scope,id), UNIQUE(scope,external_id), UNIQUE(scope,seq)
);
CREATE INDEX IF NOT EXISTS group_records_pending ON group_records(scope,seq) WHERE processed_at IS NULL;
CREATE TABLE IF NOT EXISTS group_topics (
 scope text NOT NULL REFERENCES group_scopes(scope), id uuid NOT NULL,
 title text NOT NULL, summary text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
 revision int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(scope,id)
);
CREATE TABLE IF NOT EXISTS group_record_topics (
 scope text NOT NULL, record_id uuid NOT NULL, topic_id uuid NOT NULL,
 PRIMARY KEY(scope,record_id,topic_id),
 FOREIGN KEY(scope,record_id) REFERENCES group_records(scope,id),
 FOREIGN KEY(scope,topic_id) REFERENCES group_topics(scope,id)
);
CREATE TABLE IF NOT EXISTS group_facts (
 scope text NOT NULL, id uuid NOT NULL, topic_id uuid NOT NULL,
 category text NOT NULL CHECK(category IN ('decision','task','deadline','constraint','question','insight')),
 content text NOT NULL, status text NOT NULL CHECK(status IN ('proposed','confirmed','disputed','rejected','superseded')),
 valid_from timestamptz NOT NULL, valid_to timestamptz,
 supersedes uuid, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(scope,id),
 FOREIGN KEY(scope,topic_id) REFERENCES group_topics(scope,id),
 FOREIGN KEY(scope,supersedes) REFERENCES group_facts(scope,id),
 CHECK(supersedes IS NULL OR supersedes<>id)
);
CREATE TABLE IF NOT EXISTS group_fact_sources (
 scope text NOT NULL, fact_id uuid NOT NULL, record_id uuid NOT NULL,
 PRIMARY KEY(scope,fact_id,record_id),
 FOREIGN KEY(scope,fact_id) REFERENCES group_facts(scope,id),
 FOREIGN KEY(scope,record_id) REFERENCES group_records(scope,id)
);
CREATE TABLE IF NOT EXISTS group_revisions (
 scope text NOT NULL, id uuid NOT NULL, topic_id uuid NOT NULL,
 revision int NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(scope,id), UNIQUE(scope,topic_id,revision),
 FOREIGN KEY(scope,topic_id) REFERENCES group_topics(scope,id)
);
CREATE TABLE IF NOT EXISTS group_brain_jobs (
 scope text PRIMARY KEY REFERENCES group_scopes(scope),
 next_run_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 lease uuid, lease_until timestamptz,
 attempts int NOT NULL DEFAULT 0, last_error text, last_success_at timestamptz,
 processed_count bigint NOT NULL DEFAULT 0
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['group_scopes','group_records','group_topics','group_record_topics','group_facts','group_fact_sources','group_revisions','group_brain_jobs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='group_isolation') THEN
   EXECUTE format('CREATE POLICY group_isolation ON %I USING (scope = nullif(current_setting(''zhub.group_scope'',true),'''')) WITH CHECK (scope = nullif(current_setting(''zhub.group_scope'',true),''''))',t);
  END IF;
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO zhub_group_scope',t);
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO zhub_group_scope;
GRANT USAGE,SELECT ON SEQUENCE group_records_seq_seq TO zhub_group_scope;
ALTER TABLE group_topics ADD COLUMN IF NOT EXISTS merged_into uuid;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='group_topic_merge_scope') THEN
  ALTER TABLE group_topics ADD CONSTRAINT group_topic_merge_scope FOREIGN KEY(scope,merged_into) REFERENCES group_topics(scope,id);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS group_fact_conflicts (
 scope text NOT NULL, fact_id uuid NOT NULL, other_id uuid NOT NULL,
 PRIMARY KEY(scope,fact_id,other_id),
 FOREIGN KEY(scope,fact_id) REFERENCES group_facts(scope,id),
 FOREIGN KEY(scope,other_id) REFERENCES group_facts(scope,id),CHECK(fact_id<>other_id)
);
ALTER TABLE group_fact_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_fact_conflicts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='group_fact_conflicts' AND policyname='group_isolation') THEN
 CREATE POLICY group_isolation ON group_fact_conflicts
 USING(scope=nullif(current_setting('zhub.group_scope',true),''))
 WITH CHECK(scope=nullif(current_setting('zhub.group_scope',true),''));
 END IF;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON group_fact_conflicts TO zhub_group_scope;
ALTER TABLE group_brain_jobs ADD COLUMN IF NOT EXISTS last_full_rebuild_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS group_overviews (
 scope text PRIMARY KEY REFERENCES group_scopes(scope), summary text NOT NULL,
 revision int NOT NULL DEFAULT 1, topic_versions jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_overview_versions (
 scope text NOT NULL REFERENCES group_scopes(scope),revision int NOT NULL,
 summary text NOT NULL,topic_versions jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(scope,revision)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['group_overviews','group_overview_versions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='group_isolation') THEN
   EXECUTE format('CREATE POLICY group_isolation ON %I USING(scope=nullif(current_setting(''zhub.group_scope'',true),'''')) WITH CHECK(scope=nullif(current_setting(''zhub.group_scope'',true),''''))',t);
  END IF;
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO zhub_group_scope',t);
 END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS group_records_search ON group_records USING gin(to_tsvector('simple',content));
ALTER TABLE group_records ADD COLUMN IF NOT EXISTS reply_excerpt text;
ALTER TABLE group_records ADD COLUMN IF NOT EXISTS reply_sender_id text;
