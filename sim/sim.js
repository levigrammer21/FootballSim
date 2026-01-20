// HBFL sim: hourly cron, only runs at 19:00 America/Chicago
// Phase: generate schedule (weeks 1-8) + simulate weekly games + update standings
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secrets.");
  process.exit(1);
}

function chicagoNowParts() {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

async function sbFetch(path, { method="GET", body, preferReturn=true } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: preferReturn ? "return=representation" : "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

// ---------- Scheduling ----------
function makeRoundRobinWeeks(teamIds) {
  // Circle method for even N (N=8). Produces N-1=7 rounds.
  // We'll use 7 rounds + a repeated “rivalry” round (round 8) shuffled.
  const n = teamIds.length;
  if (n % 2 !== 0) throw new Error("Need even number of teams for this scheduler.");
  const arr = [...teamIds];
  const fixed = arr[0];
  let rot = arr.slice(1);

  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const left = [fixed, ...rot.slice(0, (n/2)-1)];
    const right = rot.slice((n/2)-1).slice().reverse();
    const pairs = [];
    for (let i = 0; i < n/2; i++) {
      const a = left[i];
      const b = right[i];
      // alternate home/away by round
      if (r % 2 === 0) pairs.push([a, b]);
      else pairs.push([b, a]);
    }
    rounds.push(pairs);

    // rotate
    rot = [rot[rot.length - 1], ...rot.slice(0, rot.length - 1)];
  }

  // Week 8: repeat one round with swapped home/away for variety
  const week8 = rounds[Math.floor(Math.random() * rounds.length)].map(([h,a]) => [a,h]);
  rounds.push(week8);

  // rounds[0] => week 1, ...
  return rounds;
}

// ---------- Game sim (team-only) ----------
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Returns chance offense "wins" a matchup given ratings (0-100)
function winChance(off, def) {
  // Map to 1-10-ish space to match your intuition
  const o = off / 10;
  const d = def / 10;
  const delta = o - d;

  // Your curve: delta=2 => ~0.70, delta=5 => ~0.80
  const base = 0.5;
  const k = 0.45;
  const denom = Math.abs(delta) + 2.5;
  const frac = Math.abs(delta) / denom;
  let p = base + k * frac;
  if (delta < 0) p = 1 - p;

  return clamp(p, 0.10, 0.90);
}

// coaching modifiers
function styleMods(offStyle, defStyle) {
  // Multipliers used in scoring odds + turnover/big-play shaping
  const off = (offStyle || "neutral").toLowerCase();
  const def = (defStyle || "neutral").toLowerCase();

  const mods = {
    tdMult: 1.0,
    toMult: 1.0,
    bigMult: 1.0,
  };

  if (off === "aggressive") { mods.tdMult *= 1.12; mods.toMult *= 1.18; mods.bigMult *= 1.20; }
  if (off === "passive")    { mods.tdMult *= 0.92; mods.toMult *= 0.82; mods.bigMult *= 0.85; }

  if (def === "aggressive") { mods.tdMult *= 0.94; mods.toMult *= 1.15; mods.bigMult *= 1.10; } // more big plays allowed
  if (def === "passive")    { mods.tdMult *= 0.97; mods.toMult *= 0.90; mods.bigMult *= 0.85; }

  return mods;
}

function simOneGame(homeName, awayName, homeStrength, awayStrength, homeOffStyle, homeDefStyle, awayOffStyle, awayDefStyle) {
  // strength inputs are 0-100 "team offense/defense" numbers for now (we’ll replace with roster math later)
  const possessions = 12; // each team
  let hTD = 0, aTD = 0;
  let hY = 0, aY = 0;

  const log = [];
  log.push(`Kickoff: ${awayName} @ ${homeName}`);

  // Helper: simulate a single possession
  const simPoss = (offName, defName, offStr, defStr, offStyle, defStyle) => {
    const mods = styleMods(offStyle, defStyle);
    const pWin = winChance(offStr, defStr);          // chance to have a successful drive
    const pTO  = clamp((1 - pWin) * 0.35 * mods.toMult, 0.03, 0.22); // turnovers more likely when overmatched
    const pTD  = clamp(pWin * 0.32 * mods.tdMult, 0.10, 0.55);
    const pFG  = clamp(pWin * 0.22, 0.05, 0.35);
    const pBig = clamp(pWin * 0.18 * mods.bigMult, 0.05, 0.45);

    const r = Math.random();

    // turnover
    if (r < pTO) {
      const y = Math.floor(5 + Math.random() * 30);
      log.push(`${offName} drive ends in a TURNOVER after ${y} yards.`);
      return { td:0, yards:y };
    }

    // TD / FG / punt
    if (r < pTO + pTD) {
      const y = pBig > 0.20 && Math.random() < pBig ? Math.floor(45 + Math.random()*35) : Math.floor(55 + Math.random()*25);
      log.push(`${offName} punches in a TD! (${y} yards)`);
      return { td:1, yards:y };
    }

    if (r < pTO + pTD + pFG) {
      const y = Math.floor(35 + Math.random()*35);
      log.push(`${offName} settles for a FG drive. (${y} yards)`);
      return { td:0, yards:y };
    }

    const y = Math.floor(5 + Math.random()*25);
    log.push(`${offName} punts. (${y} yards)`);
    return { td:0, yards:y };
  };

  // Alternate possessions with a little randomness
  for (let i = 0; i < possessions; i++) {
    const h = simPoss(homeName, awayName, homeStrength.off, awayStrength.def, homeOffStyle, awayDefStyle);
    hTD += h.td;
    hY  += h.yards;

    const a = simPoss(awayName, homeName, awayStrength.off, homeStrength.def, awayOffStyle, homeDefStyle);
    aTD += a.td;
    aY  += a.yards;
  }

  // simple tiebreaker: extra possession each until not tied (cap 3)
  let ot = 0;
  while (hTD === aTD && ot < 3) {
    ot++;
    log.push(`Overtime possession ${ot}…`);
    const h = simPoss(homeName, awayName, homeStrength.off, awayStrength.def, homeOffStyle, awayDefStyle);
    const a = simPoss(awayName, homeName, awayStrength.off, homeStrength.def, awayOffStyle, homeDefStyle);
    hTD += h.td; hY += h.yards;
    aTD += a.td; aY += a.yards;
  }

  log.push(`Final: ${awayName} ${aTD} TD, ${aY} yds — ${homeName} ${hTD} TD, ${hY} yds`);
  return { homeTD:hTD, awayTD:aTD, homeY:hY, awayY:aY, log };
}

(async () => {
  const now = chicagoNowParts();

  // Only run at 19:00 (7:00 PM)
  if (!(now.hh === 19 && now.mm === 0)) {
    console.log(`Not sim time. Chicago now ${now.isoDate} ${now.hh}:${String(now.mm).padStart(2,"0")}`);
    return;
  }

  // Active seasons
  const seasons = await sbFetch(`seasons?select=*&status=in.(regular,playoffs)`);
  if (!seasons?.length) {
    console.log("No active seasons.");
    return;
  }

  for (const season of seasons) {
    if (season.last_sim_local_date === now.isoDate) {
      console.log(`Season ${season.id} already simmed for ${now.isoDate}.`);
      continue;
    }

    // Load league + teams
    const [league] = await sbFetch(`leagues?select=*&id=eq.${season.league_id}`);
    const teams = await sbFetch(`teams?select=*&league_id=eq.${season.league_id}`);
    if (!teams || teams.length !== 8) {
      console.log(`League ${season.league_id} has ${teams?.length ?? 0} teams; expected 8.`);
      continue;
    }

    // Ensure schedule exists for weeks 1-8
    const existing = await sbFetch(`games?select=id,week&season_id=eq.${season.id}&week=gte.1&week=lte.8`);
    const weeksExisting = new Set(existing.map(g => g.week));
    const teamIds = teams.map(t => t.id);

    if (weeksExisting.size < 8) {
      console.log("Generating schedule weeks 1-8…");
      const rounds = makeRoundRobinWeeks(teamIds); // 8 weeks, 4 games/week
      const inserts = [];
      for (let w = 1; w <= 8; w++) {
        if (weeksExisting.has(w)) continue;
        for (const [home, away] of rounds[w-1]) {
          inserts.push({
            season_id: season.id,
            week: w,
            home_team_id: home,
            away_team_id: away,
          });
        }
      }
      if (inserts.length) {
        await sbFetch(`games`, { method:"POST", body: inserts });
      }
    }

    // Advance week: 0 -> 1, 1 -> 2, ... up to 8
    let nextWeek = (season.week ?? 0) + 1;

    // If week is 0, start week 1 but DO NOT sim (gives everyone one day to set stuff later)
    // For now we will sim week 1 immediately to prove it works.
    if (nextWeek > 8) {
      console.log(`Season ${season.id} regular season complete (week ${season.week}). Playoffs not wired yet.`);
      // mark complete for now
      await sbFetch(`seasons?id=eq.${season.id}`, { method:"PATCH", body: { status:"complete", last_sim_local_date: now.isoDate } });
      continue;
    }

    // Fetch this week's games
    const games = await sbFetch(`games?select=*&season_id=eq.${season.id}&week=eq.${nextWeek}`);
    if (!games?.length) {
      console.log(`No games found for week ${nextWeek}.`);
      await sbFetch(`seasons?id=eq.${season.id}`, { method:"PATCH", body: { week: nextWeek, last_sim_local_date: now.isoDate } });
      continue;
    }

    // Strength model v1: everyone equal (50/50) until we wire rosters + draft
    // Still produces different results due to RNG + styles (styles are default neutral)
    const nameById = new Map(teams.map(t => [t.id, t.name]));
    const strengthById = new Map(teams.map(t => [t.id, { off: 55, def: 55 }]));

    // Sim each game if not played
    for (const g of games) {
      if (g.played_at) continue;

      const homeName = nameById.get(g.home_team_id) || "Home";
      const awayName = nameById.get(g.away_team_id) || "Away";

      const homeStr = strengthById.get(g.home_team_id);
      const awayStr = strengthById.get(g.away_team_id);

      const res = simOneGame(
        homeName, awayName,
        homeStr, awayStr,
        "neutral", "neutral",
        "neutral", "neutral"
      );

      // Update game row
      await sbFetch(`games?id=eq.${g.id}`, {
        method: "PATCH",
        body: {
          home_tds: res.homeTD,
          away_tds: res.awayTD,
          home_yards: res.homeY,
          away_yards: res.awayY,
          played_at: new Date().toISOString(),
        },
      });

      // Insert logs (cap 40 lines so it stays readable)
      const lines = res.log.slice(0, 40).map(msg => ({ game_id: g.id, message: msg }));
      await sbFetch(`game_logs`, { method:"POST", body: lines });

      // Update season_teams totals + W/L
      const homeWin = res.homeTD > res.awayTD;
      const awayWin = res.awayTD > res.homeTD;

      const homePatch = {
        wins: (homeWin ? 1 : 0),
        losses: (awayWin ? 1 : 0),
        tds_for: res.homeTD,
        tds_against: res.awayTD,
        yards_for: res.homeY,
        yards_against: res.awayY,
      };
      const awayPatch = {
        wins: (awayWin ? 1 : 0),
        losses: (homeWin ? 1 : 0),
        tds_for: res.awayTD,
        tds_against: res.homeTD,
        yards
