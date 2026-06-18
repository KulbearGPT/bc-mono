ALTER TABLE "gift_requests" ADD COLUMN "order_participant_id" UUID;

ALTER TABLE "gift_requests" ADD CONSTRAINT "gift_requests_order_participant_id_fkey"
  FOREIGN KEY ("order_participant_id") REFERENCES "order_participants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "gift_requests_order_participant_id_created_at_idx"
  ON "gift_requests"("order_participant_id", "created_at");

-- Legacy facts predate OrderParticipant. New multi-recipient requests always set this link.
UPDATE gift_requests request
SET order_participant_id = participant.id
FROM order_participants participant
WHERE request.order_id = participant.order_id
  AND request.receiver_id = participant.player_id
  AND request.order_participant_id IS NULL
  AND participant.status = 'ACTIVE';
