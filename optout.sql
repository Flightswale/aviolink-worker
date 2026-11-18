-- Aviolink: clients who replied STOP (run once in Supabase, choose "Run and enable RLS")
create table if not exists wa_optout (phone text primary key, created_at timestamptz default now());
