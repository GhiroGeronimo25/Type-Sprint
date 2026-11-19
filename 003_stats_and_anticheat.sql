-- Type Sprint, migration 3: player stats, anti-cheat flags and the leaderboard.
-- Paste this whole file into Supabase -> SQL Editor -> Run (after 001 and 002 have been run).
-- None of this moves coins. Money stays in 001/002; these tables only record how people typed.

-- ---------- one row per racer per race (ranked and casual) ----------
create table public.race_stats (
  id         bigint generated always as identity primary key,
  pid        text    not null references public.accounts(pid),
  room       text    not null,
  ranked     boolean not null,
  difficulty text    not null default 'medium',
  wpm        int     not null default 0,
  accuracy   numeric not null default 100,
  progress   numeric not null default 0,
  finished   boolean not null default false,
  missed     jsonb   not null default '{}'::jsonb,   -- { "e": 3, " ": 1 }: the letters they should have typed and got wrong
  flagged    boolean not null default false,         -- anti-cheat flagged this race: it does not count anywhere
  at         timestamptz not null default now()
);
create index race_stats_pid_idx on public.race_stats (pid, id desc);

-- ---------- what the anti-cheat saw, kept for review ----------
create table public.cheat_flags (
  id     bigint generated always as identity primary key,
  pid    text not null references public.accounts(pid),
  room   text not null,
  reason text not null check (reason in ('paste', 'burst', 'speed')),
  times  int  not null default 1,         -- how many times it happened in that race
  detail text not null default '',
  at     timestamptz not null default now()
);
create index cheat_flags_pid_idx on public.cheat_flags (pid);

alter table public.race_stats  enable row level security;
alter table public.cheat_flags enable row level security;
grant all on public.race_stats, public.cheat_flags to service_role;

-- ---------- record_race_stats: save a finished race's typing stats and any flags, in one transaction ----------
-- p_players: [{ pid, wpm, accuracy, progress, finished, missed: {char: count}, flags: [{reason, count, detail}] }]
-- A race with any flag is saved as flagged. Returns how many racers were saved.
create function public.record_race_stats(p_code text, p_ranked boolean, p_difficulty text, p_players jsonb)
returns int language plpgsql as $$
declare v_elem jsonb; v_flag jsonb; v_flags jsonb; n int := 0;
begin
  for v_elem in select value from jsonb_array_elements(p_players) loop
    v_flags := coalesce(v_elem -> 'flags', '[]'::jsonb);

    insert into public.race_stats (pid, room, ranked, difficulty, wpm, accuracy, progress, finished, missed, flagged)
    values (
      v_elem ->> 'pid', p_code, p_ranked, coalesce(nullif(p_difficulty, ''), 'medium'),
      coalesce((v_elem ->> 'wpm')::numeric, 0)::int,
      coalesce((v_elem ->> 'accuracy')::numeric, 100),
      coalesce((v_elem ->> 'progress')::numeric, 0),
      coalesce((v_elem ->> 'finished')::boolean, false),
      coalesce(v_elem -> 'missed', '{}'::jsonb),
      jsonb_array_length(v_flags) > 0
    );

    for v_flag in select value from jsonb_array_elements(v_flags) loop
      insert into public.cheat_flags (pid, room, reason, times, detail)
      values (v_elem ->> 'pid', p_code, v_flag ->> 'reason',
              coalesce((v_flag ->> 'count')::int, 1), coalesce(v_flag ->> 'detail', ''));
    end loop;

    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- player_stats: best and average WPM, accuracy trend, most-missed characters ----------
-- Flagged races are left out of everything except the "flaggedRaces" count.
create function public.player_stats(p_pid text)
returns jsonb language sql stable as $$
  with counted as (
    select * from public.race_stats where pid = p_pid and not flagged
  )
  select jsonb_build_object(
    'races',        (select count(*) from counted),
    'flaggedRaces', (select count(*) from public.race_stats where pid = p_pid and flagged),
    'bestWpm',      (select coalesce(max(wpm), 0) from counted),
    'avgWpm',       (select coalesce(round(avg(wpm))::int, 0) from counted),
    -- the last 20 races, oldest first, so a chart reads left to right
    'trend', coalesce((
      select jsonb_agg(jsonb_build_object('at', t.at, 'accuracy', t.accuracy, 'wpm', t.wpm) order by t.id)
      from (select * from counted order by id desc limit 20) t
    ), '[]'::jsonb),
    -- the 5 letters missed most, across every counted race
    'mostMissed', coalesce((
      select jsonb_agg(jsonb_build_object('ch', m.ch, 'misses', m.misses) order by m.misses desc, m.ch)
      from (
        select e.k as ch, sum(e.v::int) as misses
        from counted, jsonb_each_text(counted.missed) as e(k, v)
        group by e.k
        order by sum(e.v::int) desc, e.k
        limit 5
      ) m
    ), '[]'::jsonb)
  );
$$;

-- ---------- leaderboard: ranked players by rating ----------
-- Never exposes a pid (it is the player's secret). "isYou" marks the asking player's own row.
-- A player with 3 or more flagged races is hidden until someone reviews them.
create function public.leaderboard(p_limit int default 20, p_pid text default null)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.rating desc, r.wins desc, r.name), '[]'::jsonb)
  from (
    select a.name, a.rating, a.races, a.wins,
           coalesce((select max(s.wpm) from public.race_stats s where s.pid = a.pid and not s.flagged), 0) as "bestWpm",
           coalesce(a.pid = p_pid, false) as "isYou"
    from public.accounts a
    where a.races > 0
      and (select count(*) from public.race_stats s where s.pid = a.pid and s.flagged) < 3
    order by a.rating desc, a.wins desc, a.name
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  ) r;
$$;

-- only the server (service_role) may call these
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
