-- Usernames chosen at sign-up.
-- Paste into Supabase -> SQL Editor -> Run.
-- BEFORE running: remove duplicate/old rows from public.accounts, or the unique index below will fail.
--   (see the cleanup queries in the chat; e.g. delete rows whose pid is not in auth.users)

-- one username per player, ignoring upper/lower case
create unique index if not exists accounts_name_unique on public.accounts (lower(name));

-- when someone signs up, create their game account right away, named after the username they chose
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.join_account(
    new.id::text,
    coalesce(
      nullif(new.raw_user_meta_data->>'username', ''),
      left(regexp_replace(split_part(coalesce(new.email, ''), '@', 1), '[^A-Za-z0-9 _.-]', '', 'g'), 16)
    )
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
