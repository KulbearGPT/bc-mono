ALTER TABLE dispatch_attempts ADD COLUMN order_requirement_id UUID;
ALTER TABLE dispatch_attempts ADD CONSTRAINT dispatch_attempts_order_requirement_id_fkey
  FOREIGN KEY (order_requirement_id) REFERENCES order_requirements(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX dispatch_attempts_requirement_status_idx ON dispatch_attempts(order_requirement_id, status);

CREATE UNIQUE INDEX order_participants_one_player_requirement_idx
  ON order_participants(order_requirement_id, player_id)
  WHERE order_requirement_id IS NOT NULL AND status='ACTIVE';
