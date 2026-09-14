alter table if exists public.members
  add column if not exists mobile_number text;

comment on column public.members.mobile_number is
  'Phone number edited from Member Directory and used by the Today''s Bazar call button.';

create table if not exists public.meal_deadline_overrides (
  override_date date primary key,
  extended boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.bazar_settings (
  month_key text primary key,
  split_between integer not null check (split_between > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.bazar_periods (
  id bigserial primary key,
  month_key text not null,
  start_day integer not null,
  end_day integer not null,
  member_email text not null,
  member_name text not null,
  created_at timestamptz not null default now(),
  constraint bazar_period_valid_days check (start_day > 0 and end_day >= start_day),
  constraint bazar_period_one_member_per_month unique (month_key, member_email),
  constraint bazar_period_one_owner_per_range unique (month_key, start_day, end_day)
);
