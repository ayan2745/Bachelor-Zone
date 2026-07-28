-- Run once in Supabase SQL Editor before deploying this update.

create table if not exists public.bazar_meals (
  meal_date date primary key,
  month_key text not null,
  bazar_owner_email text not null,
  lunch_menu text not null default '',
  dinner_menu text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists bazar_meals_month_key_idx on public.bazar_meals (month_key);

-- Khala signs in with username "Khala" and password "Khala2745".
-- The application treats the Bua authority as the restricted Khala view.
insert into public.members (name, email, password_legacy, authority)
values ('Khala', 'khala', 'Khala2745', 'Bua')
on conflict (email) do update
set name = excluded.name,
    password_legacy = excluded.password_legacy,
    authority = excluded.authority;
