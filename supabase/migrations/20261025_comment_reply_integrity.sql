-- Reply integrity: a reply must target a top-level comment in the SAME exchange.
-- Matches what web/index.html renders (one reply level). Previously parent_id could point at any
-- comment, including one from another exchange or a reply-to-reply that the UI would never display.
-- Adds a validation trigger only; no grants or policies are changed. Safe to run more than once.
-- Existing rows are not rewritten; check for legacy violations with the query at the bottom.
create or replace function public.comments_reply_integrity() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if new.parent_id is null then return new; end if;
  select exchange_no, parent_id into p from public.comments where id = new.parent_id;
  if not found then raise exception 'Reply target does not exist'; end if;
  if p.exchange_no <> new.exchange_no then raise exception 'Reply must be in the same exchange as its parent'; end if;
  if p.parent_id is not null then raise exception 'Cannot reply to a reply'; end if;
  return new;
end $$;
drop trigger if exists trg_comments_reply_integrity on public.comments;
create trigger trg_comments_reply_integrity before insert on public.comments
  for each row execute function public.comments_reply_integrity();
revoke execute on function public.comments_reply_integrity() from public, anon, authenticated;

-- Legacy check (expect 0 rows):
--   select c.id from public.comments c join public.comments p on p.id = c.parent_id
--   where c.exchange_no <> p.exchange_no or p.parent_id is not null;
