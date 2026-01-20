// ======= CONFIG (paste yours) =======
const SUPABASE_URL = "PASTE_YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "PASTE_YOUR_SUPABASE_ANON_KEY";
// ====================================

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);

const authCard = $("authCard");
const appCard  = $("appCard");
const userBox  = $("userBox");
const authMsg  = $("authMsg");
const leagueArea = $("leagueArea");

$("btnMagic").onclick = async () => {
  authMsg.textContent = "Sending…";
  const email = $("email").value.trim();
  const { error } = await sb.auth.signInWithOtp({ email });
  authMsg.textContent = error ? `Error: ${error.message}` : "Sent! Tap the magic link in your email.";
};

$("btnCreateLeague").onclick = async () => {
  $("btnCreateLeague").disabled = true;
  try {
    await createLeagueHBFL();
    await render();
  } finally {
    $("btnCreateLeague").disabled = false;
  }
};

$("btnRefresh").onclick = render;

sb.auth.onAuthStateChange(async () => render());

await render();

async function render() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    authCard.classList.remove("hidden");
    appCard.classList.add("hidden");
    userBox.innerHTML = "";
    return;
  }
  authCard.classList.add("hidden");
  appCard.classList.remove("hidden");

  userBox.innerHTML = `
    <span class="muted">${session.user.email}</span>
    <button id="btnOut">Sign out</button>
  `;
  document.getElementById("btnOut").onclick = () => sb.auth.signOut();

  const league = await getMyLeague();
  if (!league) {
    leagueArea.innerHTML = `<p class="muted">No league yet. Create HBFL to begin.</p>`;
    return;
  }

  const { data: season } = await sb
    .from("seasons")
    .select("*")
    .eq("league_id", league.id)
    .order("season_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: teams } = await sb
    .from("teams")
    .select("*")
    .eq("league_id", league.id)
    .order("name", { ascending: true });

  // Standings
  const { data: standings } = await sb
    .from("season_teams")
    .select("wins,losses,tds_for,tds_against,yards_for,yards_against,team_id")
    .eq("season_id", season.id);

  const stMap = new Map((standings ?? []).map(r => [r.team_id, r]));

  leagueArea.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(league.name)}</h3>
      <p class="muted">Season ${season.season_no} • Week ${season.week} • Auto sim ${season.sim_hour.toString().padStart(2,"0")}:${season.sim_min.toString().padStart(2,"0")} ${season.tz}</p>
      <div class="grid2" id="standings"></div>
    </div>
  `;

  const box = document.getElementById("standings");
  box.innerHTML = teams.map(t => {
    const s = stMap.get(t.id) ?? { wins:0, losses:0, tds_for:0, tds_against:0, yards_for:0, yards_against:0 };
    const faceId = (hashStr(t.id) % 20 + 20) % 20; // 0..19 deterministic by team id for now
    const svg = playerAvatarSvg("face-"+faceId);
    return `
      <div class="team">
        <div class="avatar"><img alt="face" src="${svgToDataUrl(svg)}" /></div>
        <div style="flex:1">
          <div><strong>${escapeHtml(t.name)}</strong> <span class="muted">(${escapeHtml(t.abbrev)})</span></div>
          <div class="muted">W-L: ${s.wins}-${s.losses} • TD: ${s.tds_for}-${s.tds_against} • Yds: ${s.yards_for}-${s.yards_against}</div>
        </div>
      </div>
    `;
  }).join("");
}

async function getMyLeague() {
  const { data: { user } } = await sb.auth.getUser();
  const { data } = await sb
    .from("leagues")
    .select("*")
    .eq("commissioner", user.id)
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function createLeagueHBFL() {
  const { data: { user } } = await sb.auth.getUser();

  // Create league
  const { data: league, error: e1 } = await sb
    .from("leagues")
    .insert({ name: "HBFL — Has Beens Football League", commissioner: user.id })
    .select("*")
    .single();
  if (e1) throw e1;

  // Random teams
  const names = randomTeamsHBFL();
  const teamsToInsert = names.map(({ name, abbrev }) => ({ league_id: league.id, name, abbrev }));
  const { data: insertedTeams, error: e2 } = await sb
    .from("teams")
    .insert(teamsToInsert)
    .select("*");
  if (e2) throw e2;

  // Create season 1
  const { data: season, error: e3 } = await sb
    .from("seasons")
    .insert({ league_id: league.id, season_no: 1, status: "regular", week: 0 })
    .select("*")
    .single();
  if (e3) throw e3;

  // Seed season_teams
  const seasonTeams = insertedTeams.map(t => ({ season_id: season.id, team_id: t.id }));
  const { error: e4 } = await sb.from("season_teams").insert(seasonTeams);
  if (e4) throw e4;
}

function randomTeamsHBFL() {
  // 8 random, re-rolled each league creation
  const pool = [
    ["Tulsa Rust", "TRS"], ["OKC Outlaws", "OKO"], ["Broken Arrow Blitz", "BAB"], ["Norman Nightshift", "NNF"],
    ["Wichita Wranglers", "WWR"], ["KC Thunder", "KCT"], ["Dallas Last Call", "DLC"], ["Fort Worth Fugitives", "FWF"],
    ["Little Rock Rewinds", "LRR"], ["Memphis Misfits", "MMF"], ["Austin Afterhours", "AAH"], ["Houston Hangovers", "HHG"],
    ["St. Louis Slowpokes", "SLP"], ["Springfield Specials", "SPS"], ["Omaha Old Heads", "OOH"], ["Des Moines Dust", "DMD"],
  ].map(([name, abbrev]) => ({ name, abbrev }));

  shuffle(pool);
  return pool.slice(0, 8);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ======== 20-style "cartoon face" generator (SVG) ========
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function playerAvatarSvg(seedStr) {
  const rnd = mulberry32(hashStr(seedStr));
  const skin = ["#f2c9a0", "#e8b58a", "#d89a6e", "#b8774f"][Math.floor(rnd()*4)];
  const helmet = ["#2b2f77", "#1f7a3b", "#7a1f1f", "#3a3a3a", "#7a6a1f"][Math.floor(rnd()*5)];
  const stripe = ["#ffffff", "#ffd24d", "#6ee7ff", "#ff6ea8"][Math.floor(rnd()*4)];
  const eye = ["#111111", "#1b2a4a", "#3a1b1b"][Math.floor(rnd()*3)];
  const mood = Math.floor(rnd()*3);
  const visor = rnd() < 0.25;

  const mouthPath =
    mood === 0 ? "M38 66 Q50 74 62 66" :
    mood === 1 ? "M40 68 L60 68" :
                 "M38 72 Q50 64 62 72";

  const visorEl = visor
    ? `<rect x="33" y="44" width="34" height="16" rx="8" fill="#0b1220" opacity="0.75"/>`
    : "";

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="18" fill="#0b0b0b" opacity="0.06"/>
  <path d="M20 54 Q22 28 48 22 Q74 28 76 54 Q76 76 48 80 Q20 76 20 54Z" fill="${helmet}"/>
  <path d="M46 22 L50 22 L52 78 L44 78 Z" fill="${stripe}" opacity="0.9"/>
  <path d="M30 50 Q32 36 48 34 Q64 36 66 50 Q66 68 48 72 Q30 68 30 50Z" fill="${skin}"/>
  <path d="M26 52 H72" stroke="#222" stroke-width="3" stroke-linecap="round"/>
  <path d="M30 44 H66" stroke="#222" stroke-width="3" stroke-linecap="round"/>
  <path d="M30 60 H66" stroke="#222" stroke-width="3" stroke-linecap="round"/>
  ${visorEl}
  <circle cx="41" cy="52" r="3.2" fill="${eye}"/>
  <circle cx="55" cy="52" r="3.2" fill="${eye}"/>
  <path d="${mouthPath}" stroke="#4a2a2a" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>`.trim();
}
function svgToDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
// =========================================================

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
         }
