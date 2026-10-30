-- Aviolink dashboard: run once in Supabase SQL editor
alter table agencies add column if not exists status text default 'active';
alter table agencies add column if not exists auto_send boolean default false;
alter table agencies add column if not exists login_emails text[] default '{}';
alter table alerts add column if not exists client_status text;
alter table alerts add column if not exists client_mobile text;
alter table alerts add column if not exists wa_message_id text;
alter table alerts add column if not exists wa_error text;
alter table alerts add column if not exists sent_by text;
create index if not exists alerts_wa_message_id_idx on alerts (wa_message_id);
create index if not exists alerts_agency_created_idx on alerts (agency_id, created_at desc);
create index if not exists mail_log_agency_created_idx on mail_log (agency_id, created_at desc);
