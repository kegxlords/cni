-- Stores admin-managed manual deposit bank details as a JSON array.
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS deposit_accounts_json jsonb NOT NULL DEFAULT '[]'::jsonb;
