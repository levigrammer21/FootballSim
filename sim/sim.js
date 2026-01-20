// HBFL: hourly cron, simulate only at 19:00 America/Chicago
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
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

async function sbFetch(path, { method="GET", body } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

(async () => {
  const now = chicagoNowParts();

  // Only run at 19:00 (7:00 PM)
  if (!(now.hh === 19 && now.mm === 0)) {
    console.log(`Not sim time. Chicago now ${now.isoDate} ${now.hh}:${String(now.mm).padStart(2,"0")}`);
    return;
  }

  // Fetch active seasons
  const seasons = await sbFetch(`seasons?select=*&status=in.(regular,playoffs)`);
  if (!seasons?.length) {
    console.log("No active seasons.");
    return;
  }

  for (const season of seasons) {
    // Prevent double-sim same local date
    if (season.last_sim_local_date === now.isoDate) {
      console.log(`Season ${season.id} already simmed for ${now.isoDate}.`);
      continue;
    }

    // TODO: Replace this stub with full game sim.
    // For now: advance week by 1 and mark last_sim_local_date.
    const nextWeek = Math.min((season.week ?? 0) + 1, 10);

    await sbFetch(`seasons?id=eq.${season.id}`, {
      method: "PATCH",
      body: { week: nextWeek, last_sim_local_date: now.isoDate }
    });

    console.log(`✅ Sim advanced season ${season.id} to week ${nextWeek} on ${now.isoDate}`);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
