ALTER TABLE "sections" ADD COLUMN "age_up_age" smallint;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "age_up_rank_id" smallint;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_age_up_rank_id_ranks_id_fk" FOREIGN KEY ("age_up_rank_id") REFERENCES "public"."ranks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_age_up_ck" CHECK (("sections"."age_up_age" is null) = ("sections"."age_up_rank_id" is null) and ("sections"."age_up_age" is null or "sections"."age_up_age" between 4 and 25));--> statement-breakpoint
-- 已有的组别：Junior 当年满 13 岁升 Senior·Recruit；Pre-Junior 当年满 9 岁升 Junior·Member
UPDATE "sections" s SET "age_up_age" = 13, "age_up_rank_id" = r."id"
FROM "ranks" r JOIN "sections" t ON t."id" = r."section_id"
WHERE s."name" = 'Junior' AND t."name" = 'Senior' AND r."name" = 'Recruit' AND s."age_up_age" IS NULL;--> statement-breakpoint
UPDATE "sections" s SET "age_up_age" = 9, "age_up_rank_id" = r."id"
FROM "ranks" r JOIN "sections" t ON t."id" = r."section_id"
WHERE s."name" = 'Pre-Junior' AND t."name" = 'Junior' AND r."name" = 'Member' AND s."age_up_age" IS NULL;
