-- Moderation hardening (idempotent; safe to re-run).
--  1. Replies to a hidden comment are rejected (previously a visible, orphaned reply could be created
--     by anyone who knew a hidden comment's id).
--  2. Hiding a comment (auto-hide after 3 reports) also hides its replies, so nothing is left orphaned.
--     The UI only renders replies beneath visible top-level comments, so this matches what users see;
--     it additionally stops hidden threads leaking via the API.
--  3. The 5-comments-per-minute limit is serialized per user with a transaction-scoped advisory lock,
--     so concurrent inserts can no longer all observe "count < 5" and exceed the limit.

create or replace function public.comments_reply_integrity() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if new.parent_id is null then return new; end if;
  -- FOR SHARE blocks a concurrent auto-hide of the parent until this insert commits; the hide then
  -- cascades to this reply (see reports_autohide), so there is no window that leaves it visible.
  select exchange_no, parent_id, hidden into p from public.comments where id = new.parent_id for share;
  if not found then raise exception 'Reply target does not exist'; end if;
  if p.hidden then raise exception 'Cannot reply to a hidden comment'; end if;
  if p.exchange_no <> new.exchange_no then raise exception 'Reply must be in the same exchange as its parent'; end if;
  if p.parent_id is not null then raise exception 'Cannot reply to a reply'; end if;
  return new;
end $$;

create or replace function public.reports_autohide() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.reports where comment_id = new.comment_id) >= 3 then
    update public.comments set hidden = true where id = new.comment_id;
    update public.comments set hidden = true where parent_id = new.comment_id and not hidden;
  end if;
  return new;
end $$;

create or replace function public.comments_rate_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Serialize this user's inserts; the lock is released at commit/rollback. In READ COMMITTED the
  -- count below takes a fresh snapshot after the lock is granted, so it sees earlier committed inserts.
  perform pg_advisory_xact_lock(724130002, hashtext(new.user_id::text));
  if (select count(*) from public.comments
      where user_id = new.user_id and created_at > now() - interval '1 minute') >= 5 then
    raise exception 'Slow down — too many comments';
  end if;
  return new;
end $$;

revoke execute on function public.comments_reply_integrity() from public, anon, authenticated;
revoke execute on function public.comments_rate_limit() from public, anon, authenticated;
revoke execute on function public.reports_autohide() from public, anon, authenticated;

-- One-time backfill: hide replies whose parent is already hidden.
update public.comments c set hidden = true
from public.comments p
where c.parent_id = p.id and p.hidden and not c.hidden;
