CREATE TYPE "ExperienceReviewTargetType" AS ENUM ('ORDER', 'PLAYER', 'SUPPORT');
CREATE TYPE "OrderReviewPublicationStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

CREATE TABLE "order_experience_reviews" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "target_type" "ExperienceReviewTargetType" NOT NULL,
  "target_key" VARCHAR(120) NOT NULL,
  "order_participant_id" UUID,
  "attributed_staff_id" UUID,
  "score" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_experience_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_experience_reviews_score_chk" CHECK ("score" BETWEEN 1 AND 5),
  CONSTRAINT "order_experience_reviews_target_chk" CHECK (
    ("target_type"='ORDER' AND "order_participant_id" IS NULL AND "attributed_staff_id" IS NULL) OR
    ("target_type"='PLAYER' AND "order_participant_id" IS NOT NULL AND "attributed_staff_id" IS NULL) OR
    ("target_type"='SUPPORT' AND "order_participant_id" IS NULL AND "attributed_staff_id" IS NOT NULL)
  ),
  CONSTRAINT "order_experience_reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_experience_reviews_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_experience_reviews_order_participant_id_fkey" FOREIGN KEY ("order_participant_id") REFERENCES "order_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_experience_reviews_attributed_staff_id_fkey" FOREIGN KEY ("attributed_staff_id") REFERENCES "staff_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "order_experience_reviews_order_id_target_key_key" ON "order_experience_reviews"("order_id","target_key");
CREATE INDEX "order_experience_reviews_order_participant_id_created_at_idx" ON "order_experience_reviews"("order_participant_id","created_at");
CREATE INDEX "order_experience_reviews_attributed_staff_id_created_at_idx" ON "order_experience_reviews"("attributed_staff_id","created_at");
CREATE INDEX "order_experience_reviews_customer_id_created_at_idx" ON "order_experience_reviews"("customer_id","created_at");

CREATE TABLE "order_experience_review_comments" (
  "id" UUID NOT NULL,
  "review_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "comment" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_experience_review_comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_experience_review_comments_nonempty_chk" CHECK (length(trim("comment")) BETWEEN 1 AND 500),
  CONSTRAINT "order_experience_review_comments_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "order_experience_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_experience_review_comments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "order_experience_review_comments_review_id_key" ON "order_experience_review_comments"("review_id");
CREATE INDEX "order_experience_review_comments_customer_id_created_at_idx" ON "order_experience_review_comments"("customer_id","created_at");

CREATE TABLE "order_review_publications" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "snapshot" JSONB NOT NULL,
  "status" "OrderReviewPublicationStatus" NOT NULL DEFAULT 'PENDING',
  "broadcast_channel_id" VARCHAR(32),
  "broadcast_message_id" VARCHAR(32),
  "consented_at" TIMESTAMPTZ(3) NOT NULL,
  "published_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_review_publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_review_publications_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_review_publications_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "order_review_publications_order_id_key" ON "order_review_publications"("order_id");
CREATE UNIQUE INDEX "order_review_publications_broadcast_message_id_key" ON "order_review_publications"("broadcast_message_id");
CREATE INDEX "order_review_publications_status_created_at_idx" ON "order_review_publications"("status","created_at");
CREATE INDEX "order_review_publications_customer_id_created_at_idx" ON "order_review_publications"("customer_id","created_at");

CREATE FUNCTION prevent_order_experience_review_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'order experience reviews and comments are append-only'; END; $$;
CREATE TRIGGER "order_experience_reviews_append_only" BEFORE UPDATE OR DELETE ON "order_experience_reviews" FOR EACH ROW EXECUTE FUNCTION prevent_order_experience_review_mutation();
CREATE TRIGGER "order_experience_review_comments_append_only" BEFORE UPDATE OR DELETE ON "order_experience_review_comments" FOR EACH ROW EXECUTE FUNCTION prevent_order_experience_review_mutation();

CREATE FUNCTION protect_order_review_publication_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'order review publications cannot be deleted'; END IF;
  IF OLD."order_id" IS DISTINCT FROM NEW."order_id" OR OLD."customer_id" IS DISTINCT FROM NEW."customer_id" OR OLD."snapshot" IS DISTINCT FROM NEW."snapshot" OR OLD."consented_at" IS DISTINCT FROM NEW."consented_at" THEN
    RAISE EXCEPTION 'order review publication consent snapshot is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "order_review_publications_snapshot_immutable" BEFORE UPDATE OR DELETE ON "order_review_publications" FOR EACH ROW EXECUTE FUNCTION protect_order_review_publication_snapshot();

INSERT INTO "order_experience_reviews" ("id","order_id","customer_id","target_type","target_key","attributed_staff_id","score","created_at")
SELECT "id","order_id","customer_id",'SUPPORT'::"ExperienceReviewTargetType",'support:' || "attributed_staff_id"::text,"attributed_staff_id","score","created_at"
FROM "order_support_ratings" WHERE "attributed_staff_id" IS NOT NULL
ON CONFLICT ("order_id","target_key") DO NOTHING;
INSERT INTO "order_experience_review_comments" ("id","review_id","customer_id","comment","created_at")
SELECT gen_random_uuid(),new_review."id",old_rating."customer_id",old_rating."comment",old_rating."created_at"
FROM "order_support_ratings" old_rating
JOIN "order_experience_reviews" new_review ON new_review."id"=old_rating."id"
WHERE old_rating."comment" IS NOT NULL AND length(trim(old_rating."comment"))>0
ON CONFLICT ("review_id") DO NOTHING;

GRANT SELECT, INSERT ON "order_experience_reviews", "order_experience_review_comments", "order_review_publications" TO blackcat_app;
GRANT UPDATE ("status","broadcast_channel_id","broadcast_message_id","published_at","updated_at") ON "order_review_publications" TO blackcat_app;
