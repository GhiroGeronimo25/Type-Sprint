-- Type Sprint, migration 2: 60/30/10 prize split, and race results saved inside the payout transaction.
-- Paste this whole file into Supabase -> SQL Editor -> Run (after 001_init.sql has been run).

-- ---------- race results ----------
create table public.race_results (
  id       bigint generated always as identity primary key,
  room     text not null,
  ranked   boolean not null default true,
  text     text not null default '',
  ended_at timestamptz not null default now()
);

create table public.race_result_players (
  result_id     bigint  not null references public.race_results(id) on delete cascade,
  rank          int     not null,
  pid           text    not null references public.accounts(pid),
  name          text    not null,
  wpm           int     not null default 0,
  accuracy      numeric not null default 100,
  finished      boolean not null default false,
  progress      numeric not null default 0,
  seconds       numeric,
  payout        int     not null default 0,
  net           int     not null default 0,
  rating_before int     not null,
  rating_after  int     not null,
  primary key (result_id, rank)
);
create index race_result_players_pid_idx on public.race_result_players (pid);

alter table public.race_results        enable row level security;
alter table public.race_result_players enable row level security;
grant all on public.race_results, public.race_result_players to service_role;

-- ---------- settle_race, now with the 60/30/10 split and the results saved in the same transaction ----------
-- p_ranked: [{ pid, active, name, wpm, accuracy, finished, progress, seconds }] in finishing order.
-- Pays the pot by placement (1st 60%, 2nd 30%, 3rd 10%; with only two typists 70/30; one typist takes it all),
-- updates every rating and saves the results. If any step fails, ALL of it is rolled back.
drop function public.settle_race(text, jsonb);

create function public.settle_race(p_code text, p_ranked jsonb, p_text text default '')
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
  v_result_id bigint; v_elem jsonb;
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
                                        else array[0.6, 0.3, 0.1]::numeric[] end;   -- 1st 60%, 2nd 30%, 3rd 10%
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

  -- 4. save the race results (skipped when nobody typed, so there is nothing to rank)
  if not v_refund_all then
    insert into public.race_results (room, ranked, text) values (p_code, true, coalesce(p_text, ''))
    returning id into v_result_id;
    for i in 1..n loop
      v_elem := p_ranked -> (i - 1);
      insert into public.race_result_players
        (result_id, rank, pid, name, wpm, accuracy, finished, progress, seconds, payout, net, rating_before, rating_after)
      values (v_result_id, i, v_pids[i],
        coalesce(nullif(v_elem->>'name', ''), 'Racer'),
        coalesce((v_elem->>'wpm')::numeric, 0)::int,
        coalesce((v_elem->>'accuracy')::numeric, 100),
        coalesce((v_elem->>'finished')::boolean, false),
        coalesce((v_elem->>'progress')::numeric, 0),
        (v_elem->>'seconds')::numeric,
        v_prize[i], v_prize[i] - v_fee, v_before[i], v_after[i]);
    end loop;
  end if;

  delete from public.pots where code = p_code;                      -- cascades to pot_entrants
  return v_result;
end $$;

-- re-apply who may call what (the new function would otherwise be callable with the public key)
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
