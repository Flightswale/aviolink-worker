-- Aviolink self-test: run once in Supabase SQL editor
create table if not exists test_mails (
  id bigserial primary key,
  agency_id text,
  message_id text unique,
  subject text,
  raw text,
  expected jsonb,
  created_at timestamptz default now()
);
