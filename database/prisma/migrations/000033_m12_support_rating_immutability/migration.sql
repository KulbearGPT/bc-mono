CREATE TRIGGER "trg_order_support_ratings_append_only"
BEFORE UPDATE OR DELETE ON "order_support_ratings"
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();
