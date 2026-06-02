-- Repair onboarding identities created separately from an existing Discord-linked user.
-- Only onboarding-owned facts are moved automatically; ambiguous merges fail closed.

CREATE TEMP TABLE onboarding_identity_merges AS
SELECT DISTINCT
  task.user_id AS split_user_id,
  discord.user_id AS target_user_id
FROM discord_product_role_tasks task
JOIN discord_accounts discord
  ON discord.guild_id = task.guild_id
 AND discord.discord_user_id = task.discord_user_id
WHERE task.user_id <> discord.user_id
  AND task.action = 'ADD'
  AND task.dedupe_key LIKE 'product-role:%:ADD:player'
  AND NOT EXISTS (
    SELECT 1 FROM discord_accounts split_discord WHERE split_discord.user_id = task.user_id
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM onboarding_identity_merges merge
    JOIN wallet_accounts split_wallet ON split_wallet.user_id = merge.split_user_id
    JOIN wallet_accounts target_wallet ON target_wallet.user_id = merge.target_user_id
  ) THEN
    RAISE EXCEPTION 'onboarding identity repair found users with two wallets';
  END IF;

  IF EXISTS (
    SELECT 1 FROM onboarding_identity_merges merge
    JOIN player_profiles split_profile ON split_profile.user_id = merge.split_user_id
    JOIN player_profiles target_profile ON target_profile.user_id = merge.target_user_id
  ) THEN
    RAISE EXCEPTION 'onboarding identity repair found users with two player profiles';
  END IF;

  IF EXISTS (
    SELECT 1 FROM onboarding_identity_merges merge
    WHERE EXISTS (SELECT 1 FROM audit_logs row WHERE row.actor_user_id = merge.split_user_id)
       OR EXISTS (SELECT 1 FROM cancellation_previews row WHERE row.requested_by_user_id = merge.split_user_id)
       OR EXISTS (SELECT 1 FROM fund_reservation_events row WHERE row.actor_user_id = merge.split_user_id)
       OR EXISTS (SELECT 1 FROM idempotency_records row WHERE row.actor_user_id = merge.split_user_id)
       OR EXISTS (SELECT 1 FROM order_events row WHERE row.actor_user_id = merge.split_user_id)
       OR EXISTS (SELECT 1 FROM refunds row WHERE row.requested_by_user_id = merge.split_user_id)
  ) THEN
    RAISE EXCEPTION 'onboarding identity repair requires manual review for immutable actor facts';
  END IF;
END $$;

UPDATE wallet_accounts wallet
SET user_id = merge.target_user_id,
    row_version = wallet.row_version + 1,
    updated_at = CURRENT_TIMESTAMP
FROM onboarding_identity_merges merge
WHERE wallet.user_id = merge.split_user_id;

UPDATE player_profiles profile
SET user_id = merge.target_user_id,
    row_version = profile.row_version + 1,
    updated_at = CURRENT_TIMESTAMP
FROM onboarding_identity_merges merge
WHERE profile.user_id = merge.split_user_id;

UPDATE discord_product_role_tasks task
SET user_id = merge.target_user_id,
    updated_at = CURRENT_TIMESTAMP
FROM onboarding_identity_merges merge
WHERE task.user_id = merge.split_user_id;

UPDATE users target
SET display_name = split.display_name,
    row_version = target.row_version + 1,
    updated_at = CURRENT_TIMESTAMP
FROM onboarding_identity_merges merge
JOIN users split ON split.id = merge.split_user_id
WHERE target.id = merge.target_user_id;

DELETE FROM users split
USING onboarding_identity_merges merge
WHERE split.id = merge.split_user_id;

DROP TABLE onboarding_identity_merges;
