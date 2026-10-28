-- Sino Case Tracker v2 tables (Supabase project bbofkhxjafgljsbtcyrp).
-- New tables only; the old case_snapshots / case_change_log and the bakery tables are untouched.
-- Run once in Supabase SQL Editor.

create table if not exists cl_case_snapshots (
  case_key       text primary key,          -- e.g. ENGAGE:cs:CS5056186
  source         text not null,             -- ENGAGE | NEXIDIA | WFM
  cs_number      text,
  owner          text,
  owner_email    text,
  site           text,
  status         text,
  start_date     date,
  target_date    date,
  end_date       date,
  closed_at      date,                      -- first day the case was seen closed
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create index if not exists cl_case_snapshots_owner_idx on cl_case_snapshots (owner_email);

-- Start date / Target date edits (audit log)
create table if not exists cl_case_changes (
  id               bigint generated always as identity primary key,
  detected_at      timestamptz not null default now(),
  case_key         text not null,
  source           text,
  cs_number        text,
  owner            text,
  owner_email      text,
  site             text,
  field            text not null check (field in ('start_date','target_date')),
  old_value        date,
  new_value        date,
  direction        text,                    -- later | earlier | set | cleared
  last_modified_by text,                    -- who saved the file last (file level)
  file_modified_at timestamptz
);
create index if not exists cl_case_changes_detected_idx on cl_case_changes (detected_at desc);
create index if not exists cl_case_changes_case_idx on cl_case_changes (case_key);

-- Every alert email attempt. A successful (ok) row blocks re-sending the same dedupe_key.
create table if not exists cl_alert_log (
  id          bigint generated always as identity primary key,
  sent_at     timestamptz not null default now(),
  dedupe_key  text not null,                -- <case>|r1, <case>|r2, <case>|overdue|YYYY-MM-DD
  case_key    text not null,
  source      text,
  cs_number   text,
  owner       text,
  owner_email text,
  site        text,
  alert_type  text not null check (alert_type in ('r1','r2','overdue')),
  case_age    int,
  to_list     text,
  cc_list     text,
  subject     text,
  ok          boolean not null default true,
  error       text
);
create unique index if not exists cl_alert_log_dedupe_ok on cl_alert_log (dedupe_key) where ok;
create index if not exists cl_alert_log_sent_idx on cl_alert_log (sent_at desc);
create index if not exists cl_alert_log_case_idx on cl_alert_log (case_key);

-- Manager report schedules (edited from the dashboard)
create table if not exists cl_report_schedules (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  name          text not null,
  enabled       boolean not null default true,
  frequency     text not null default 'weekly' check (frequency in ('daily','weekly','monthly')),
  day_of_week   int default 1 check (day_of_week between 1 and 7),   -- 1 = Monday
  day_of_month  int default 1 check (day_of_month between 1 and 28),
  send_time     text not null default '08:30',                        -- HH:MM, Asia/Bangkok
  range_type    text not null default 'prev_week',
  recipients    text not null,
  cc            text,
  attach_excel  boolean not null default true,
  last_period   text,                                                 -- YYYY-MM-DD of last send
  last_sent_at  timestamptz
);

create table if not exists cl_report_log (
  id           bigint generated always as identity primary key,
  sent_at      timestamptz not null default now(),
  schedule_id  bigint references cl_report_schedules(id) on delete set null,
  title        text,
  range_from   date,
  range_to     date,
  recipients   text,
  cc           text,
  file_name    text,
  ok           boolean not null default true,
  error        text
);

-- The service uses the service_role key; keep these tables closed to anon/public.
alter table cl_case_snapshots   enable row level security;
alter table cl_case_changes     enable row level security;
alter table cl_alert_log        enable row level security;
alter table cl_report_schedules enable row level security;
alter table cl_report_log       enable row level security;

-- Starter schedule (disabled): weekly report every Monday 08:30.
-- Put the manager's real address in on the dashboard, then switch it on.
insert into cl_report_schedules (name, enabled, frequency, day_of_week, send_time, range_type, recipients, cc)
select 'Weekly Report', false, 'weekly', 1, '08:30', 'prev_week', 'manager@sinostech.co.th', 'engineer@sinostech.co.th'
where not exists (select 1 from cl_report_schedules);
