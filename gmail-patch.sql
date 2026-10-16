-- Aviolink: Sign in with Google (Gmail direct read). Paste in Supabase SQL Editor -> Run (safe to re-run)
alter table agencies add column if not exists gmail_email text;
alter table agencies add column if not exists gmail_refresh_token text;
alter table agencies add column if not exists gmail_connected_at timestamptz;
alter table agencies add column if not exists gmail_backfill_status text;   -- pending | running | done | error
alter table agencies add column if not exists gmail_error text;
