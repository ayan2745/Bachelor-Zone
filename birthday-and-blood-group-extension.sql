-- Run once in Supabase SQL Editor before deploying this update.
-- Adds the Birthday & Blood Group feature:
--   * members.birthday    -> used to drive the pre-birthday countdown banner
--                              and the birthday-day confetti blast.
--   * members.blood_group -> shown in the Admin member directory.
--   * members.updated_at  -> "last updated" timestamp, bumped whenever a
--                              member's profile is edited or a meal entry is
--                              submitted/edited for them. Drives the ordering
--                              of the "Today's Live Meal Update" list on the
--                              main dashboard (most recently updated first).

alter table if exists public.members
  add column if not exists birthday date;

alter table if exists public.members
  add column if not exists blood_group text;

alter table if exists public.members
  add column if not exists updated_at timestamptz not null default now();

-- Keep blood group values constrained to the standard 8 groups (or empty).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'members_blood_group_check'
  ) then
    alter table public.members
      add constraint members_blood_group_check
      check (blood_group is null or blood_group = '' or blood_group in
        ('A+','A-','B+','B-','AB+','AB-','O+','O-'));
  end if;
end $$;

comment on column public.members.birthday is
  'Member date of birth (year is stored but only month/day are used by the app).';
comment on column public.members.blood_group is
  'One of A+, A-, B+, B-, AB+, AB-, O+, O- (or empty if unknown).';
comment on column public.members.updated_at is
  'Bumped on profile edits and on meal submissions for this member; drives dashboard ordering.';

-- Backfill: give any existing rows a starting updated_at so they sort
-- sensibly (oldest) until they're next touched.
update public.members set updated_at = now() where updated_at is null;

create index if not exists members_updated_at_idx on public.members (updated_at desc);
