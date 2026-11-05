CREATE TYPE "public"."change_request_kind" AS ENUM('user_access', 'role', 'rank_access');--> statement-breakpoint
CREATE TYPE "public"."change_request_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "permission_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "change_request_kind" NOT NULL,
	"target_id" text NOT NULL,
	"changes" jsonb NOT NULL,
	"reason" text,
	"status" "change_request_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "rank_permissions" (
	"rank_id" smallint NOT NULL,
	"permission_slug" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rank_permissions_pk" PRIMARY KEY("rank_id","permission_slug")
);
--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "system_key" text;--> statement-breakpoint
ALTER TABLE "permission_change_requests" ADD CONSTRAINT "permission_change_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_change_requests" ADD CONSTRAINT "permission_change_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_permissions" ADD CONSTRAINT "rank_permissions_rank_id_ranks_id_fk" FOREIGN KEY ("rank_id") REFERENCES "public"."ranks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_permissions" ADD CONSTRAINT "rank_permissions_permission_slug_permissions_slug_fk" FOREIGN KEY ("permission_slug") REFERENCES "public"."permissions"("slug") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_permissions" ADD CONSTRAINT "rank_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "permission_change_requests_status_idx" ON "permission_change_requests" USING btree ("status","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_change_requests_one_pending_uq" ON "permission_change_requests" USING btree ("kind","target_id") WHERE "permission_change_requests"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_system_key_unique" UNIQUE("system_key");