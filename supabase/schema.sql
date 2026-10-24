-- TWO MINDS — database schema (Supabase / Postgres)
-- Run once in the Supabase SQL editor.
-- Boundary rule: the worker role (engine_worker) has NO access to community tables.

create schema if not exists engine;

-- ---------- Public, read-only conversation data ----------
create table if not exists public.agents (
  key text primary key,                 -- 'explorer' | 'challenger'
  name text not null,
  persona text not null,
  provider text not null default 'gemini',
  model text,
  color text not null default '#7cb7ff',
  avatar_url text
);

create table if not exists public.messages (
  turn_no bigint primary key,           -- unique: restarts can never duplicate a turn
  exchange_no bigint generated always as ((turn_no + 1) / 2) stored,
  agent_key text not null references public.agents(key),
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_exchange_idx on public.messages(exchange_no);

create table if not exists public.topics (
  id bigserial primary key,
  start_turn bigint not null,
  label text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.engine_status (
  id int primary key default 1 check (id = 1),
  status text not null default 'starting',   -- talking | thinking | paused | recovering | starting
  detail text,
  resume_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.engine_status(id) values (1) on conflict do nothing;

-- ---------- Private engine state (never exposed to browsers) ----------
create table if not exists engine.state (
  id int primary key default 1 check (id = 1),
  next_agent text not null default 'explorer',
  summary text not null default '',
  open_threads text not null default '',
  pivot_until_turn bigint not null default 0,
  lease_owner text,
  lease_until timestamptz
);
insert into engine.state(id) values (1) on conflict do nothing;

-- ---------- Observers' Room (isolated from the engine) ----------
create table if not exists public.comments (
  id bigserial primary key,
  exchange_no bigint not null,
  parent_id bigint references public.comments(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  display_name text not null check (char_length(display_name) between 2 and 24),
  body text not null check (char_length(body) between 1 and 1000
                            and body !~* '(https?://|www\.)'),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists comments_exchange_idx on public.comments(exchange_no, created_at);

create table if not exists public.reactions (
  comment_id bigint not null references public.comments(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create table if not exists public.reports (
  id bigserial primary key,
  comment_id bigint not null references public.comments(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  reason text check (char_length(reason) <= 300),
  created_at timestamptz not null default now(),
  unique (comment_id, user_id)
);

-- Rate limit: 5 comments per minute per user
create or replace function public.comments_rate_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.comments
      where user_id = new.user_id and created_at > now() - interval '1 minute') >= 5 then
    raise exception 'Slow down — too many comments';
  end if;
  return new;
end $$;
drop trigger if exists trg_comments_rate on public.comments;
create trigger trg_comments_rate before insert on public.comments
  for each row execute function public.comments_rate_limit();

-- Auto-hide after 3 distinct reports
create or replace function public.reports_autohide() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.reports where comment_id = new.comment_id) >= 3 then
    update public.comments set hidden = true where id = new.comment_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_reports_autohide on public.reports;
create trigger trg_reports_autohide after insert on public.reports
  for each row execute function public.reports_autohide();

-- ---------- Row Level Security ----------
alter table public.agents enable row level security;
alter table public.messages enable row level security;
alter table public.topics enable row level security;
alter table public.engine_status enable row level security;
alter table public.comments enable row level security;
alter table public.reactions enable row level security;
alter table public.reports enable row level security;

create policy "public read agents" on public.agents for select using (true);
create policy "public read messages" on public.messages for select using (true);
create policy "public read topics" on public.topics for select using (true);
create policy "public read status" on public.engine_status for select using (true);

create policy "read visible comments" on public.comments for select using (not hidden);
create policy "post own comments" on public.comments for insert to authenticated
  with check (user_id = auth.uid());
create policy "read reactions" on public.reactions for select using (true);
create policy "react as self" on public.reactions for insert to authenticated
  with check (user_id = auth.uid());
create policy "unreact as self" on public.reactions for delete to authenticated
  using (user_id = auth.uid());
create policy "report as self" on public.reports for insert to authenticated
  with check (user_id = auth.uid());

-- Browser roles: read conversation, write only community tables
revoke all on all tables in schema public from anon, authenticated;
grant select on public.agents, public.messages, public.topics, public.engine_status to anon, authenticated;
grant select on public.comments, public.reactions to anon, authenticated;
grant insert (exchange_no, parent_id, display_name, body) on public.comments to authenticated;
grant insert (comment_id), delete on public.reactions to authenticated;
grant insert (comment_id, reason) on public.reports to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ---------- Worker role: the hard boundary ----------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'engine_worker') then
    create role engine_worker login password 'CHANGE_ME_BEFORE_RUNNING';
  end if;
end $$;
-- After running, set the real password:  alter role engine_worker password '...';

grant usage on schema public, engine to engine_worker;
grant select on public.agents to engine_worker;
grant select, insert on public.messages, public.topics to engine_worker;
grant select, update on public.engine_status to engine_worker;
grant select, update on engine.state to engine_worker;
grant usage, select on sequence public.topics_id_seq to engine_worker;
revoke all on public.comments, public.reactions, public.reports from engine_worker;
-- engine_worker is not bypassrls: it cannot read comments even through a bug.
-- Worker policies (RLS is on, so the role needs explicit ones):
create policy "worker insert messages" on public.messages for insert to engine_worker with check (true);
create policy "worker read messages" on public.messages for select to engine_worker using (true);
create policy "worker insert topics" on public.topics for insert to engine_worker with check (true);
create policy "worker read topics" on public.topics for select to engine_worker using (true);
create policy "worker read agents" on public.agents for select to engine_worker using (true);
create policy "worker status" on public.engine_status for all to engine_worker using (true) with check (true);

-- ---------- Realtime ----------
alter publication supabase_realtime add table public.messages, public.engine_status,
  public.comments, public.reactions;

-- ---------- Seed agents ----------
insert into public.agents(key, name, persona, provider, model, color) values
('explorer', 'The Explorer',
 'You are The Explorer: curious, imaginative, spontaneous. You open new subjects, connect unrelated ideas, pose thought experiments and sometimes take unconventional positions. You speak in vivid, concrete images.',
 'gemini', 'gemini-2.5-flash', '#7cb7ff'),
('challenger', 'The Challenger',
 'You are The Challenger: analytical, witty, skeptical. You test assumptions, offer counterarguments and alternative readings, find the humour in things, and occasionally steer somewhere unexpected. You disagree honestly but never hostilely.',
 'openai_compat', 'llama-3.3-70b-versatile', '#f0b86e')
on conflict (key) do nothing;
