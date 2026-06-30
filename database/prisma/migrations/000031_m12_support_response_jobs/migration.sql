CREATE OR REPLACE FUNCTION schedule_support_response_jobs() RETURNS trigger AS $$
BEGIN
  IF NEW.order_id IS NOT NULL AND NEW.response_status = 'NOT_REQUIRED' THEN
    NEW.response_status := 'PENDING';
    NEW.response_due_at := NEW.created_at + interval '5 minutes';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER staff_tasks_set_support_response_deadline
BEFORE INSERT ON staff_tasks FOR EACH ROW EXECUTE FUNCTION schedule_support_response_jobs();

CREATE OR REPLACE FUNCTION enqueue_support_response_jobs() RETURNS trigger AS $$
BEGIN
  IF NEW.response_status = 'PENDING' THEN
    INSERT INTO outbox_events (id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at)
    VALUES
      (gen_random_uuid(),'SUPPORT_RESPONSE_REMINDER','staff_task',NEW.id,NEW.order_id,'support-response-reminder:'||NEW.id,jsonb_build_object('staffTaskId',NEW.id),'PENDING',1,0,8,NEW.created_at + interval '4 minutes',NEW.created_at,NEW.created_at),
      (gen_random_uuid(),'SUPPORT_RESPONSE_OVERDUE','staff_task',NEW.id,NEW.order_id,'support-response-overdue:'||NEW.id,jsonb_build_object('staffTaskId',NEW.id),'PENDING',1,0,8,NEW.created_at + interval '5 minutes',NEW.created_at,NEW.created_at)
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER staff_tasks_enqueue_support_response_jobs
AFTER INSERT ON staff_tasks FOR EACH ROW EXECUTE FUNCTION enqueue_support_response_jobs();
