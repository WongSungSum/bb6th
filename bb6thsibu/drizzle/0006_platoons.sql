CREATE TYPE "public"."platoon_role" AS ENUM('leader', 'assistant');--> statement-breakpoint
CREATE TABLE "platoon_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"activity_date" date NOT NULL,
	"note" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platoon_activities_void_ck" CHECK (("platoon_activities"."voided_at" IS NULL) = ("platoon_activities"."void_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "platoon_scores" (
	"activity_id" uuid NOT NULL,
	"platoon_id" smallint NOT NULL,
	"points" integer NOT NULL,
	CONSTRAINT "platoon_scores_pk" PRIMARY KEY("activity_id","platoon_id"),
	CONSTRAINT "platoon_scores_points_ck" CHECK ("platoon_scores"."points" BETWEEN -1000 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "platoons" (
	"id" "smallserial" PRIMARY KEY NOT NULL,
	"section_id" smallint NOT NULL,
	"name" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platoons_id_section_uq" UNIQUE("id","section_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "platoon_id" smallint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "platoon_role" "platoon_role";--> statement-breakpoint
ALTER TABLE "platoon_activities" ADD CONSTRAINT "platoon_activities_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platoon_activities" ADD CONSTRAINT "platoon_activities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platoon_activities" ADD CONSTRAINT "platoon_activities_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platoon_scores" ADD CONSTRAINT "platoon_scores_activity_id_platoon_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."platoon_activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platoon_scores" ADD CONSTRAINT "platoon_scores_platoon_id_platoons_id_fk" FOREIGN KEY ("platoon_id") REFERENCES "public"."platoons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platoons" ADD CONSTRAINT "platoons_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platoon_activities_date_idx" ON "platoon_activities" USING btree ("activity_date");--> statement-breakpoint
CREATE UNIQUE INDEX "platoons_name_lower_uq" ON "platoons" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_platoon_section_fk" FOREIGN KEY ("platoon_id","section_id") REFERENCES "public"."platoons"("id","section_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_platoon_idx" ON "users" USING btree ("platoon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_platoon_role_uq" ON "users" USING btree ("platoon_id","platoon_role") WHERE "users"."platoon_role" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_platoon_role_ck" CHECK ("users"."platoon_role" IS NULL OR "users"."platoon_id" IS NOT NULL);