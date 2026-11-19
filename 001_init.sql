-- Type Sprint: accounts, ledger and race pots.
-- Paste this whole file into Supabase -> SQL Editor -> Run. It is safe to run once on a fresh project.
-- Every money operation is a function, and a function call is ONE transaction:
-- if anything inside it raises an error, every change it made is rolled back.

-- ---------- tables ----------
create table public.accounts (
  pid        text primary key,
  name       text not null default 'Racer',
  rating     int  not null default 1000,
  coins      int  not null default 500 check (coins >= 0),   -- a wallet can never go negative
  races      int  not null default 0,
  wins       int  not null default 0,
  created_at timestamptz not null default now()
);

create table public.ledger (
  id      bigint generated always as identity primary key,
  pid     text not null references public.accounts(pid),
  type    text not null check (type in ('grant', 'entry', 'refund', 'reward')),
  amount  int  not null,
  balance int  not null,
  room    text not null default '',
  at      timestamptz not null default now()
);
create index ledger_pid_idx on public.ledger (pid, id desc);

create table public.pots (
  code       text primary key,
  fee        int  not null check (fee > 0),
  amount     int  not null default 0 check (amount >= 0),
  created_at timestamptz not null default now()
);

create table public.pot_entrants (
  code text not null references public.pots(code) on delete cascade,
  pid  text not null references public.accounts(pid),
  primary key (code, pid)
);

-- Row Level Security on, with no policies: the public API (anon / logged-in users) can read and write nothing.
-- Only the server, using the service_role key, gets in.
alter table public.accounts     enable row level security;
alter table public.ledger       enable row level security;
alter table public.pots         enable row level security;
alter table public.pot_entrants enable row level security;

-- "Automatically expose new tables" is off, so give the server's role access explicitly.
grant usage on schema public to service_role;
grant all on public.accounts, public.ledger, public.pots, public.pot_entrants to service_role;

-- ---------- helper: the account snapshot sent to the player ----------
create function public.account_view(p_pid text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'rating', a.rating, 'coins', a.coins, 'races', a.races, 'wins', a.wins,
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object('at', l.at, 'type', l.type, 'amount', l.amount, 'balance', l.balance, 'room', l.room) order by l.id desc)
      from (select * from public.ledger where pid = a.pid order by id desc limit 10) l
    ), '[]'::jsonb)
  )
  from public.accounts a where a.pid = p_pid;
$$;

-- ---------- join_account: create on first visit (with the starting grant), keep the name fresh ----------
create function public.join_account(p_pid text, p_name text)
returns jsonb language plpgsql as $$
declare v_coins int;
begin
  insert into public.accounts (pid, name) values (p_pid, coalesce(nullif(p_name, ''), 'Racer'))
  on conflict (pid) do nothing
  returning coins into v_coins;

  if found then
    insert into public.ledger (pid, type, amount, balance, room) values (p_pid, 'grant', v_coins, v_coins, '');
  elsif p_name is not null and p_name <> '' then
    update public.accounts set name = p_name where pid = p_pid and name <> p_name;
  end if;
  return public.account_view(p_pid);
end $$;

-- ---------- collect_entries: entry fees -> race pot, ONE transaction ----------
-- Debits every racer who can pay and creates the pot together. Racers who can't pay are left out.
-- Returns { entered: [pid...], pot: total }.
create function public.collect_entries(p_code text, p_pids text[], p_fee int)
returns jsonb language plpgsql as $$
declare v_entered text[];
begin
  -- lock the wallets in a fixed order so two races starting at once can't deadlock
  perform 1 from public.accounts where pid = any(p_pids) order by pid for update;

  insert into public.pots (code, fee) values (p_code, p_fee);   -- a pot that already exists raises an error -> everything rolls back

  with paid as (
    update public.accounts set coins = coins - p_fee
    where pid = any(p_pids) and coins >= p_fee                    -- affordability is checked while the row is locked
    returning pid, coins
  ), l as (
    insert into public.ledger (pid, type, amount, balance, room)
    select pid, 'entry', -p_fee, coins, p_code from paid
  ), e as (
    insert into public.pot_entrants (code, pid) select p_code, pid from paid returning pid
  )
  select coalesce(array_agg(pid), '{}') into v_entered from e;

  if cardinality(v_entered) = 0 then
    delete from public.pots where code = p_code;
  else
    update public.pots set amount = p_fee * cardinality(v_entered) where code = p_code;
  end if;
  return jsonb_build_object('entered', to_jsonb(v_entered), 'pot', p_fee * cardinality(v_entered));
end $$;

-- ---------- refund_entry: a racer leaves before the race starts ----------
-- Returns what is left in the pot.
create function public.refund_entry(p_code text, p_pid text)
returns int language plpgsql as $$
declare v_fee int; v_amount int; v_balance int;
begin
  select fee, amount into v_fee, v_amount from public.pots where code = p_code for update;
  if not found then return 0; end if;

  delete from public.pot_entrants where code = p_code and pid = p_pid;
  if not found then return v_amount; end if;                       -- not in the pot (or already refunded): nothing to do

  update public.accounts set coins = coins + v_fee where pid = p_pid returning coins into v_balance;
  insert into public.ledger (pid, type, amount, balance, room) values (p_pid, 'refund', v_fee, v_balance, p_code);

  update public.pots set amount = amount - v_fee where code = p_code returning amount into v_amount;
  if v_amount = 0 then delete from public.pots where code = p_code; end if;
  return v_amount;
end $$;

-- ---------- void_pot: race cancelled -> everyone still in the pot gets their fee back ----------
create function public.void_pot(p_code text)
returns text[] language plpgsql as $$
declare v_fee int; v_pids text[];
begin
  select fee into v_fee from public.pots where code = p_code for update;
  if not found then return '{}'; end if;

  perform 1 from public.accounts where pid in (select pid from public.pot_entrants where code = p_code) order by pid for update;

  with upd as (
    update public.accounts a set coins = a.coins + v_fee
    from public.pot_entrants e
    where e.code = p_code and a.pid = e.pid
    returning a.pid, a.coins
  ), l as (
    insert into public.ledger (pid, type, amount, balance, room)
    select pid, 'refund', v_fee, coins, p_code from upd
  )
  select coalesce(array_agg(pid), '{}') into v_pids from upd;

  delete from public.pots where code = p_code;
  return v_pids;
end $$;

-- run at server start: a race that was in progress when the server stopped never finishes
create function public.void_all_pots()
returns int language plpgsql as $$
declare r record; n int := 0;
begin
  for r in select code from public.pots loop
    perform public.void_pot(r.code);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- settle_race: prizes + ratings + closing the pot, ONE transaction ----------
-- p_ranked: [{ "pid": "...", "active": true }] in finishing order (active = typed at least one letter).
-- Fees of racers who left mid-race stay in the pot. If the prizes don't add up to the pot exactly, it all rolls back.
-- Returns { pid: { rank, payout, net, ratingBefore, ratingAfter, ratingDelta } }.
create function public.settle_race(p_code text, p_ranked jsonb)
returns jsonb language plpgsql as $$
declare
  c_k constant double precision := 32;
  v_fee int; v_pot int;
  v_entrants text[];
  v_pids text[]; v_active boolean[];
  n int; n_active int;
  v_refund_all boolean := false;
  v_shares numeric[];
  v_act_idx int[] := '{}';
  v_prize int[]; v_before int[]; v_after int[]; v_delta double precision[];
  v_total int; v_paid int; i int; j int; k int;
  v_expected double precision;
  v_balance int; v_result jsonb := '{}'::jsonb;
  v_pid text; v_rating int;
begin
  select fee, amount into v_fee, v_pot from public.pots where code = p_code for update;
  if not found then raise exception 'Race % has no pot to pay out', p_code; end if;
  select array_agg(pid) into v_entrants from public.pot_entrants where code = p_code;

  select array_agg(x->>'pid' order by ord), array_agg(coalesce((x->>'active')::boolean, false) order by ord)
    into v_pids, v_active
  from jsonb_array_elements(p_ranked) with ordinality as t(x, ord);
  n := coalesce(cardinality(v_pids), 0);
  if n = 0 then raise exception 'Race % has nobody to pay', p_code; end if;

  if (select count(distinct p) from unnest(v_pids) p) <> n then raise exception 'Duplicate racer in race %', p_code; end if;
  if exists (select 1 from unnest(v_pids) p where p <> all(v_entrants)) then
    raise exception 'A racer in % never paid into the pot', p_code;
  end if;

  perform 1 from public.accounts where pid = any(v_entrants) order by pid for update;

  -- 1. prizes
  v_prize := array_fill(0, array[n]);
  for i in 1..n loop
    if v_active[i] then v_act_idx := v_act_idx || i; end if;
  end loop;
  n_active := cardinality(v_act_idx);

  if n_active = 0 then
    v_refund_all := true;                                           -- nobody typed: everyone gets their entry back
    for i in 1..n loop v_prize[i] := v_fee; end loop;
    v_total := v_fee * cardinality(v_entrants);                     -- leavers are refunded too (below)
  else
    v_shares := case least(n_active, 3) when 1 then array[1]::numeric[]
                                        when 2 then array[0.7, 0.3]::numeric[]
                                        else array[0.5, 0.3, 0.2]::numeric[] end;
    v_paid := 0;
    for k in 1..cardinality(v_shares) loop
      v_prize[v_act_idx[k]] := floor(v_pot * v_shares[k]);
      v_paid := v_paid + v_prize[v_act_idx[k]];
    end loop;
    v_prize[v_act_idx[1]] := v_prize[v_act_idx[1]] + (v_pot - v_paid);   -- rounding leftovers go to the winner
    v_total := 0;
    for i in 1..n loop v_total := v_total + v_prize[i]; end loop;
  end if;
  if v_total <> v_pot then
    raise exception 'Pot % holds % but % would be paid out', p_code, v_pot, v_total;
  end if;

  -- 2. ratings: every pair of racers is a small Elo match, averaged
  v_before := array_fill(0, array[n]);
  v_delta  := array_fill(0::double precision, array[n]);
  for i in 1..n loop
    select rating into v_rating from public.accounts where pid = v_pids[i];
    v_before[i] := v_rating;
  end loop;
  for i in 1..n loop
    for j in i + 1..n loop
      v_expected := 1 / (1 + power(10::double precision, (v_before[j] - v_before[i])::double precision / 400.0));
      v_delta[i] := v_delta[i] + c_k * (1 - v_expected);
      v_delta[j] := v_delta[j] - c_k * (1 - v_expected);
    end loop;
  end loop;
  v_after := v_before;
  if n > 1 then
    for i in 1..n loop
      v_after[i] := greatest(100, v_before[i] + floor(v_delta[i] / (n - 1) + 0.5)::int);   -- floor(x+0.5) rounds like JS Math.round
    end loop;
  end if;

  -- 3. post everything
  for i in 1..n loop
    update public.accounts
       set coins  = coins + v_prize[i],
           rating = v_after[i],
           races  = races + 1,
           wins   = wins + case when n > 1 and i = 1 and v_active[i] then 1 else 0 end
     where pid = v_pids[i]
     returning coins into v_balance;
    if v_prize[i] > 0 then
      insert into public.ledger (pid, type, amount, balance, room)
      values (v_pids[i], case when v_refund_all then 'refund' else 'reward' end, v_prize[i], v_balance, p_code);
    end if;
    v_result := v_result || jsonb_build_object(v_pids[i], jsonb_build_object(
      'rank', i, 'payout', v_prize[i], 'net', v_prize[i] - v_fee,
      'ratingBefore', v_before[i], 'ratingAfter', v_after[i], 'ratingDelta', v_after[i] - v_before[i]));
  end loop;

  if v_refund_all then                                              -- entrants who left the room before the end
    for v_pid in select e.pid from public.pot_entrants e where e.code = p_code and e.pid <> all(v_pids) loop
      update public.accounts set coins = coins + v_fee where pid = v_pid returning coins into v_balance;
      insert into public.ledger (pid, type, amount, balance, room) values (v_pid, 'refund', v_fee, v_balance, p_code);
    end loop;
  end if;

  delete from public.pots where code = p_code;                      -- cascades to pot_entrants
  return v_result;
end $$;

-- Only the server (service_role) may call these. Without this, Supabase would let anyone with the public key call them.
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
