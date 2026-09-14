-- Run once in Supabase SQL Editor before deploying this update.
-- Adds a single-row settings table so the admin panel can change the
-- lunch/dinner meal-submission cutoff hours at any time, instead of
-- them being hardcoded in the app.

create table if not exists public.meal_time_settings (
  id integer primary key default 1,
  lunch_cutoff_hour  smallint not null default 11,  -- 24h clock, e.g. 11 = 11:00 AM
  dinner_cutoff_hour smallint not null default 18,  -- 24h clock, e.g. 18 = 6:00 PM
  updated_at timestamptz not null default now(),
  constraint meal_time_settings_single_row check (id = 1),
  constraint meal_time_settings_hour_range check (
    lunch_cutoff_hour  between 0 and 23 and
    dinner_cutoff_hour between 0 and 23
  ),
  constraint meal_time_settings_order check (dinner_cutoff_hour > lunch_cutoff_hour)
);

-- Seed the single settings row with today's defaults (11 AM / 6 PM) if empty.
insert into public.meal_time_settings (id, lunch_cutoff_hour, dinner_cutoff_hour)
values (1, 11, 18)
on conflict (id) do nothing;
