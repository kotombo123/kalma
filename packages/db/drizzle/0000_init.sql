CREATE TABLE "alert_timeline" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" integer NOT NULL,
	"team_id" text NOT NULL,
	"source_id" text NOT NULL,
	"schema_id" text NOT NULL,
	"group_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"color" text,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"ingest_ts" bigint NOT NULL,
	"last_event" jsonb NOT NULL,
	"group_members" jsonb,
	"runbook_instance_id" text,
	"ack_by" text,
	"ack_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"next_escalation_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_id" text NOT NULL,
	"step_id" text NOT NULL,
	"code" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"via" text,
	CONSTRAINT "approvals_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "channel_addresses" (
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "channel_addresses_user_id_channel_pk" PRIMARY KEY("user_id","channel")
);
--> statement-breakpoint
CREATE TABLE "channel_prefs" (
	"user_id" text NOT NULL,
	"severity" text NOT NULL,
	"in_hours" text[] NOT NULL,
	"off_hours" text[] NOT NULL,
	CONSTRAINT "channel_prefs_user_id_severity_pk" PRIMARY KEY("user_id","severity")
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"fallback_of" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"team_id" text,
	"team_role" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_id" text NOT NULL,
	"version" integer NOT NULL,
	"roles" jsonb NOT NULL,
	"severity_map" jsonb,
	"resolved_values" jsonb,
	"preset_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "oncall_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"user_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oncall_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"rotation" text NOT NULL,
	"handoff_time" text DEFAULT '09:00' NOT NULL,
	"timezone" text DEFAULT 'Europe/Warsaw' NOT NULL,
	"participants" text[] NOT NULL,
	"start_date" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_versions" (
	"rule_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"author_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_versions_rule_id_version_pk" PRIMARY KEY("rule_id","version")
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"origin" text DEFAULT 'ui' NOT NULL,
	"file_path" text,
	"file_error" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runbook_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_id" text NOT NULL,
	"runbook_id" text NOT NULL,
	"runbook_version" integer NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"source" text NOT NULL,
	"matches" jsonb,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schemas" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'new' NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sample" jsonb,
	"guessed_roles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mapping_id" text,
	"event_count" bigint DEFAULT 0 NOT NULL,
	"unmatched_count" bigint DEFAULT 0 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"system_id" text NOT NULL,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"config" jsonb NOT NULL,
	"format" text DEFAULT 'auto' NOT NULL,
	"parser_options" jsonb,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text,
	"text" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "systems" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"teams_webhook_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_link_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Europe/Warsaw' NOT NULL,
	"working_hours" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "alert_timeline" ADD CONSTRAINT "alert_timeline_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_addresses" ADD CONSTRAINT "channel_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_prefs" ADD CONSTRAINT "channel_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mappings" ADD CONSTRAINT "mappings_schema_id_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."schemas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_overrides" ADD CONSTRAINT "oncall_overrides_schedule_id_oncall_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."oncall_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_overrides" ADD CONSTRAINT "oncall_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_schedules" ADD CONSTRAINT "oncall_schedules_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_versions" ADD CONSTRAINT "rule_versions_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runbook_instances" ADD CONSTRAINT "runbook_instances_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runbooks" ADD CONSTRAINT "runbooks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runbooks" ADD CONSTRAINT "runbooks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_system_id_systems_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "systems" ADD CONSTRAINT "systems_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_timeline_alert" ON "alert_timeline" USING btree ("alert_id","ts");--> statement-breakpoint
CREATE INDEX "alerts_org_status_last_seen" ON "alerts" USING btree ("org_id","status","last_seen" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alerts_undispatched" ON "alerts" USING btree ("dispatched_at") WHERE "alerts"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "alerts_escalation" ON "alerts" USING btree ("next_escalation_at") WHERE "alerts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "alerts_rule_group" ON "alerts" USING btree ("rule_id","group_key");--> statement-breakpoint
CREATE INDEX "approvals_code" ON "approvals" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_alert_user_channel" ON "deliveries" USING btree ("alert_id","user_id","channel");--> statement-breakpoint
CREATE INDEX "deliveries_pending" ON "deliveries" USING btree ("next_attempt_at") WHERE "deliveries"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "mappings_schema_version" ON "mappings" USING btree ("schema_id","version");--> statement-breakpoint
CREATE INDEX "rules_org" ON "rules" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schemas_org_fingerprint" ON "schemas" USING btree ("org_id","fingerprint");