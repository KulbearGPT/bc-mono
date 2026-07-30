CREATE OR REPLACE FUNCTION guard_order_requirement_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order requirements cannot be deleted';
  END IF;
  IF EXISTS (SELECT 1 FROM orders WHERE id = OLD.order_id AND status = 'DRAFT') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(current_setting('app.admin_order_note_recovery', true), '') = 'approved'
    AND NEW.row_version = OLD.row_version + 1
    AND (to_jsonb(NEW) - ARRAY['customer_note','row_version','updated_at'])
      = (to_jsonb(OLD) - ARRAY['customer_note','row_version','updated_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'only draft order requirements or approved staff note corrections can be changed';
END;
$$ LANGUAGE plpgsql;
