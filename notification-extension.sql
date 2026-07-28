-- Run once in Supabase SQL Editor before deploying this update.
-- Adds the notification feature: a shared notification feed (auto + user-sent)
-- with per-user read tracking, auto-purged after 3 days.

create table if not exists public.notifications (
  id bigserial primary key,
  title text not null,
  message text not null,
  notif_type text not null default 'custom',        -- 'auto_morning' | 'auto_evening' | 'custom'
  created_by_email text not null default '',         -- '' for system/automated notifications
  created_by_name  text not null default 'System',
  created_at timestamptz not null default now()
);

create index if not exists notifications_created_at_idx on public.notifications (created_at);

create table if not exists public.notification_reads (
  notification_id bigint not null references public.notifications(id) on delete cascade,
  member_email text not null,
  read_at timestamptz not null default now(),
  primary key (notification_id, member_email)
);

create index if not exists notification_reads_email_idx on public.notification_reads (member_email);

-- Housekeeping: the API also runs this cleanup on every notification-related
-- request, but you can run it manually any time to purge old rows immediately.
delete from public.notifications where created_at < now() - interval '3 days';
