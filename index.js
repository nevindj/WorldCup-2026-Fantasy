import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pool, { query } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

const SECRET_KEY = "my_super_secret_jwt_key_2026";

// ── API #1: football-data.org — Fixtures, Scores, Squads ─────────────────────
const FD_KEY  = "0944d8d832df47c3827688b9494f1d2a";
const FD_BASE = "https://api.football-data.org/v4";

// ── API #2: api-football (api-sports.io) — Player Stats, Events, Ratings ─────
const AF_KEY  = "0df5297fded38ef10b3a2a27646bb59f";
const AF_BASE = "https://v3.football.api-sports.io";

// ── API #3: TheStatsAPI — Confirmed Lineups ────────────────────────────────────
const TSA_KEY  = "fapi_xSHIGvpzG2B2EIoIMa9RmrNIBMZE8mBY";
const TSA_BASE = "https://api.thestatsapi.com/api";
// WC 2026 identifiers on TheStatsAPI
const TSA_COMPETITION_ID = "comp_6107";
const TSA_SEASON_ID      = "sn_118868";

// ── In-memory caches ──────────────────────────────────────────────────────────
const CACHE_5MIN  = 5  * 60 * 1000;
const CACHE_1HR   = 60 * 60 * 1000;

let fixturesCache     = null;
let fixturesCacheTime = 0;
let squadCache        = {};  // { teamId: { data, time } }
let afStatsCache      = {};  // { fixtureId: { data, time } }
let tournamentStatsCache = null; // { data: Map<normName, stats>, time }
const TOURNAMENT_LEAGUE_ID = 1; // api-football World Cup league ID

// TheStatsAPI match list cache so we don't re-fetch on every lineup poll
let tsaMatchListCache     = null;
let tsaMatchListCacheTime = 0;

// ── Seeded PRNG (Mulberry32) — deterministic per team id ─────────────────────
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function strToSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ── API fetch helpers ─────────────────────────────────────────────────────────
async function fdFetch(endpoint) {
  const res = await fetch(`${FD_BASE}${endpoint}`, {
    headers: { "X-Auth-Token": FD_KEY },
  });
  if (!res.ok) throw new Error(`FD API Error ${res.status}: ${res.statusText}`);
  return res.json();
}

async function afFetch(endpoint) {
  const res = await fetch(`${AF_BASE}${endpoint}`, {
    headers: {
      "x-rapidapi-key": AF_KEY,
      "x-apisports-key": AF_KEY,
    },
  });
  if (!res.ok) throw new Error(`AF API Error ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── football-data.org: fetch all WC matches (5 min cache) ────────────────────
async function fetchMatches() {
  const now = Date.now();
  if (fixturesCache && now - fixturesCacheTime < CACHE_5MIN) return fixturesCache;

  console.log("[FD] Fetching WC 2026 fixtures...");
  const data = await fdFetch("/competitions/WC/matches");

  fixturesCache = data.matches.map((m) => ({
    id: m.id,
    date: m.utcDate,
    status: m.status,
    round: m.stage + (m.group ? ` - ${m.group}` : ""),
    homeTeam: {
      id: m.homeTeam.id,
      name: m.homeTeam.shortName || m.homeTeam.name || "TBD",
      logo: m.homeTeam.crest,
    },
    awayTeam: {
      id: m.awayTeam.id,
      name: m.awayTeam.shortName || m.awayTeam.name || "TBD",
      logo: m.awayTeam.crest,
    },
    score: {
      home: m.score?.fullTime?.home ?? null,
      away: m.score?.fullTime?.away ?? null,
    },
  }));
  fixturesCacheTime = now;
  return fixturesCache;
}

const afDateCache = {}; 
async function fetchAfFixturesByDate(dateStr) {
  const now = Date.now();
  if (afDateCache[dateStr] && now - afDateCache[dateStr].time < CACHE_1HR)
    return afDateCache[dateStr].data;

  try {
    const data = await afFetch(`/fixtures?date=${dateStr}`);
    const wcFixtures = (data.response || []).filter(f => f.league?.id === 1);
    afDateCache[dateStr] = { data: wcFixtures, time: now };
    return wcFixtures;
  } catch (err) {
    return [];
  }
}

function teamNamesMatch(a, b) {
  const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z\s]/g,"").trim();
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wordsA = na.split(/\s+/).filter(w => w.length >= 4);
  const wordsB = nb.split(/\s+/).filter(w => w.length >= 4);
  return wordsA.some(w => nb.includes(w)) || wordsB.some(w => na.includes(w));
}

async function findAfFixture(fdMatch) {
  const d = new Date(fdMatch.date);
  const dates = [
    d.toISOString().slice(0, 10),
    new Date(d - 86400000).toISOString().slice(0, 10),
    new Date(d + 86400000).toISOString().slice(0, 10),
  ];

  for (const dateStr of dates) {
    const fixtures = await fetchAfFixturesByDate(dateStr);
    const found = fixtures.find(f => {
      const homeOk = teamNamesMatch(fdMatch.homeTeam.name, f.teams?.home?.name || "");
      const awayOk = teamNamesMatch(fdMatch.awayTeam.name, f.teams?.away?.name || "");
      return homeOk && awayOk;
    });
    if (found) return found;
  }
  return null;
}

function normName(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

async function fetchRealPlayerStats(afFixtureId, homeScore, awayScore) {
  const now = Date.now();
  if (afStatsCache[afFixtureId] && now - afStatsCache[afFixtureId].time < CACHE_1HR) {
    return afStatsCache[afFixtureId].data;
  }

  const [data, eventsRes] = await Promise.all([
    afFetch(`/fixtures/players?fixture=${afFixtureId}`),
    afFetch(`/fixtures/events?fixture=${afFixtureId}`)
  ]);
  
  const events = eventsRes.response || [];
  const statsMap = {};

  (data.response || []).forEach((teamData, teamIdx) => {
    const isHome = teamIdx === 0;
    const teamCleanSheet = isHome ? awayScore === 0 : homeScore === 0;

    (teamData.players || []).forEach((entry) => {
      const s   = entry.statistics?.[0] || {};
      const name = entry.player?.name || "";
      if (!name) return;

      const explicitEvents = events
        .filter(ev => normName(ev.player?.name) === normName(name))
        .map(ev => ({ time: ev.time.elapsed, type: ev.type, detail: ev.detail }));

      const minutesPlayed = s.games?.minutes ?? 0;
      const goals    = s.goals?.total    ?? 0;
      const assists  = s.goals?.assists  ?? 0;
      const yellow   = (s.cards?.yellow  ?? 0) > 0;
      const red      = (s.cards?.red     ?? 0) > 0;
      const saves    = s.goalkeeper?.saves ?? 0;
      const rating   = parseFloat(s.games?.rating) || 0;
      const cleanSheet = teamCleanSheet && minutesPlayed >= 60;

      statsMap[normName(name)] = {
        goals, assists,
        yellowCard: yellow,
        redCard: red,
        saves,
        minutesPlayed,
        rating,
        cleanSheet,
        explicitEvents
      };
    });
  });

  afStatsCache[afFixtureId] = { data: statsMap, time: now };
  return statsMap;
}

function lookupPlayerStat(statsMap, playerName) {
  const key = normName(playerName);
  if (statsMap[key]) return statsMap[key];
  const parts = key.split(" ").filter(p => p.length >= 4);
  for (const entry of Object.keys(statsMap)) {
    if (parts.some(p => entry.includes(p))) return statsMap[entry];
  }
  return null;
}

function calcRealPoints(player, stat, isCaptain, isVC) {
  // If player is on bench and played 0 minutes, points = 0
  if (!player.isStarter && (!stat || stat.minutesPlayed < 1)) {
     return { basePoints: 0, finalPoints: 0, multiplier: 1, events: { minutesPlayed: 0, realData: true, explicitLog: [] } };
  }
  // Even if starter, if didn't play = 0
  if (!stat || stat.minutesPlayed < 1) {
    return { basePoints: 0, finalPoints: 0, multiplier: isCaptain ? 2 : isVC ? 1.5 : 1,
      events: { scored: false, assist: false, cleanSheet: false, yellowCard: false, redCard: false,
        saves: 0, minutesPlayed: 0, rating: 0, realData: true, explicitLog: [] } };
  }

  let pts = 2; 
  let explicitLog = [{ msg: "Appearance", pts: "+2", time: null }];

  const goalPts = player.position === "Attacker" ? 4 : player.position === "Midfielder" ? 5 : player.position === "Defender" ? 6 : 10;
  if (stat.goals > 0) {
    pts += stat.goals * goalPts;
    stat.explicitEvents.filter(e => e.type === "Goal" && e.detail !== "Missed Penalty").forEach(e => {
       explicitLog.push({ msg: `Goal`, pts: `+${goalPts}`, time: e.time });
    });
  }

  if (stat.assists > 0) {
    pts += stat.assists * 3;
    explicitLog.push({ msg: `Assist (${stat.assists})`, pts: `+${stat.assists * 3}`, time: null });
  }

  if (stat.cleanSheet) {
    const csPts = player.position === "Goalkeeper" ? 6 : player.position === "Defender" ? 4 : 0;
    if (csPts > 0) {
      pts += csPts;
      explicitLog.push({ msg: "Clean Sheet", pts: `+${csPts}`, time: null });
    }
  }

  if (player.position === "Goalkeeper" && stat.saves > 0) {
    const savePts = Math.floor(stat.saves / 3);
    if (savePts > 0) {
      pts += savePts;
      explicitLog.push({ msg: `Saves (${stat.saves})`, pts: `+${savePts}`, time: null });
    }
  }

  if (stat.rating >= 8.0) { pts += 2; explicitLog.push({ msg: "Rating ≥8.0", pts: "+2", time: null }); }
  else if (stat.rating >= 7.0) { pts += 1; explicitLog.push({ msg: "Rating ≥7.0", pts: "+1", time: null }); }

  if (stat.yellowCard) {
    pts -= 1;
    stat.explicitEvents.filter(e => e.type === "Card" && e.detail === "Yellow Card").forEach(e => {
       explicitLog.push({ msg: `Yellow Card`, pts: "-1", time: e.time });
    });
  }
  if (stat.redCard) {
    pts -= 3;
    stat.explicitEvents.filter(e => e.type === "Card" && e.detail === "Red Card").forEach(e => {
       explicitLog.push({ msg: `Red Card`, pts: "-3", time: e.time });
    });
  }

  pts = Math.max(0, pts);
  const multiplier  = isCaptain ? 2 : isVC ? 1.5 : 1;
  const finalPoints = Math.round(pts * multiplier);

  return {
    basePoints: pts,
    finalPoints,
    multiplier,
    events: {
      scored:      stat.goals > 0,
      assist:      stat.assists > 0,
      cleanSheet:  stat.cleanSheet,
      yellowCard:  stat.yellowCard,
      redCard:     stat.redCard,
      saves:       stat.saves,
      minutesPlayed: stat.minutesPlayed,
      rating:      stat.rating,
      realData:    true,
      explicitLog
    },
  };
}

async function buildRealBreakdown(team, fdMatch) {
  try {
    const afFixture = await findAfFixture(fdMatch);
    if (!afFixture) return null;

    const homeScore = fdMatch.score?.home ?? 0;
    const awayScore = fdMatch.score?.away ?? 0;
    const statsMap  = await fetchRealPlayerStats(afFixture.fixture.id, homeScore, awayScore);

    const breakdown = team.players.map((p) => {
      const isCaptain = p.id === team.captain;
      const isVC      = p.id === team.viceCaptain;
      const stat      = lookupPlayerStat(statsMap, p.name);
      return { id: p.id, name: p.name, position: p.position, isStarter: p.isStarter, ...calcRealPoints(p, stat, isCaptain, isVC) };
    });

    const totalPoints = breakdown.reduce((s, p) => s + p.finalPoints, 0);
    return { breakdown, totalPoints };
  } catch (err) {
    return null;
  }
}

function generateSimulatedBreakdown(players, captain, viceCaptain, seedId) {
  const breakdown = players.map((p) => {
    const isCaptain = p.id === captain;
    const isVC      = p.id === viceCaptain;

    return {
      id: p.id, name: p.name, position: p.position, isStarter: p.isStarter,
      basePoints: 0, finalPoints: 0, multiplier: isCaptain ? 2 : isVC ? 1.5 : 1,
      events: { scored: false, assist: false, cleanSheet: false, yellowCard: false, redCard: false, saves: 0, rating: 0, minutesPlayed: 0, realData: false, explicitLog: [] },
    };
  });

  return { breakdown, totalPoints: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION & PREMIUM
// ═══════════════════════════════════════════════════════════════════════════════

app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Missing fields" });

  const existing = await query('SELECT * FROM users WHERE username = ?', [username]);
  if (existing.length > 0) return res.json({ success: false, message: "Username already exists" });

  const id = Date.now().toString();
  await query('INSERT INTO users (id, username, password, wallet) VALUES (?, ?, ?, 1000)', [id, username, password]);

  const token = jwt.sign({ id, username }, SECRET_KEY);
  res.json({ success: true, token, user: { id, username, isPremium: false, wallet: 1000 } });
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  const users = await query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
  if (users.length === 0) return res.json({ success: false, message: "Invalid credentials" });

  const user = users[0];
  const isPremium = user.premium_until && new Date(user.premium_until) > new Date();
  const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY);
  res.json({ success: true, token, user: { 
    id: user.id, 
    username: user.username, 
    isPremium,
    premium_until: user.premium_until,
    premium_plan: user.premium_plan,
    wallet: user.wallet ?? 1000
  } });
});

const authMiddleware = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: "No token" });
  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.userId = decoded.id;
    // check premium status
    const users = await query('SELECT premium_until FROM users WHERE id = ?', [decoded.id]);
    if (users.length > 0) {
      req.isPremium = users[0].premium_until && new Date(users[0].premium_until) > new Date();
    }
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};

app.post("/api/auth/upgrade", authMiddleware, async (req, res) => {
  const { plan, password } = req.body; // 'week', 'month', 'year'

  // Verify password first
  const users = await query('SELECT password FROM users WHERE id = ?', [req.userId]);
  if (users.length === 0 || users[0].password !== password) {
    return res.status(401).json({ success: false, message: "Incorrect password" });
  }

  let days = 0;
  let planName = '';
  if (plan === 'week') { days = 7; planName = '1 Week Plan'; }
  else if (plan === 'month') { days = 30; planName = '1 Month Plan'; }
  else if (plan === 'year') { days = 365; planName = '1 Year Plan'; }
  else return res.status(400).json({ success: false, message: "Invalid plan" });

  const date = new Date();
  date.setDate(date.getDate() + days);
  
  await query('UPDATE users SET premium_until = ?, premium_plan = ? WHERE id = ?', [date, planName, req.userId]);
  res.json({ success: true, message: "Successfully upgraded to Premium!", premium_until: date, premium_plan: planName });
});

app.post("/api/auth/cancel-premium", authMiddleware, async (req, res) => {
  await query('UPDATE users SET premium_until = NULL, premium_plan = NULL WHERE id = ?', [req.userId]);
  res.json({ success: true, message: "Successfully canceled Premium subscription." });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MATCHES & SQUADS
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/api/matches", async (req, res) => {
  try {
    res.json(await fetchMatches());
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch fixtures" });
  }
});

app.get("/api/match-players/:matchId", async (req, res) => {
  try {
    const matchId = parseInt(req.params.matchId);
    const matches = await fetchMatches();
    const match   = matches.find((m) => m.id === matchId);

    if (!match) return res.status(404).json({ error: "Match not found" });
    if (!match.homeTeam.id || !match.awayTeam.id)
      return res.json({ match, homePlayers: [], awayPlayers: [] });

    const fetchTeam = async (teamId) => {
      const now = Date.now();
      if (squadCache[teamId] && now - squadCache[teamId].time < CACHE_1HR)
        return squadCache[teamId].data;
      const data = await fdFetch(`/teams/${teamId}`);
      squadCache[teamId] = { data: data.squad, time: now };
      return data.squad;
    };

    const [homeSquad, awaySquad] = await Promise.all([
      fetchTeam(match.homeTeam.id),
      fetchTeam(match.awayTeam.id),
    ]);

    const mapPlayers = (squad) => (squad || []).map((p) => {
      let pos = "Midfielder";
      if (p.position === "Goalkeeper") pos = "Goalkeeper";
      if (p.position === "Defence"  || p.position === "Defender")  pos = "Defender";
      if (p.position === "Offence"  || p.position === "Attacker" || p.position === "Forward") pos = "Attacker";
      return {
        id: p.id, name: p.name, position: pos,
        photo: `https://ui-avatars.com/api/?name=${encodeURIComponent(p.name)}&background=random`,
        price: pos === "Attacker" ? 10 : pos === "Midfielder" ? 8.5 : pos === "Defender" ? 7 : 6,
      };
    });

    res.json({ match, homePlayers: mapPlayers(homeSquad), awayPlayers: mapPlayers(awaySquad) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch match players" });
  }
});

app.get("/api/recommendations/:matchId", authMiddleware, async (req, res) => {
  if (!req.isPremium) return res.status(403).json({ error: "Premium feature only" });

  try {
    const matchId = parseInt(req.params.matchId);
    const allMatches = await fetchMatches();
    const fdMatch = allMatches.find((m) => m.id === matchId);
    if (!fdMatch) return res.status(404).json({ error: "Match not found" });
    if (!fdMatch.homeTeam.id || !fdMatch.awayTeam.id)
      return res.json({ success: true, recommendations: [] });

    // ── 1. Fetch both squads (uses cache) ──────────────────────────────────────
    const fetchSquad = async (teamId) => {
      const now = Date.now();
      if (squadCache[teamId] && now - squadCache[teamId].time < CACHE_1HR)
        return squadCache[teamId].data || [];
      const data = await fdFetch(`/teams/${teamId}`);
      squadCache[teamId] = { data: data.squad || [], time: now };
      return data.squad || [];
    };

    const mapPos = (p) => {
      if (p.position === "Goalkeeper") return "Goalkeeper";
      if (["Defence", "Defender"].includes(p.position)) return "Defender";
      if (["Offence", "Attacker", "Forward"].includes(p.position)) return "Attacker";
      return "Midfielder";
    };

    const [homeSquad, awaySquad] = await Promise.all([
      fetchSquad(fdMatch.homeTeam.id),
      fetchSquad(fdMatch.awayTeam.id),
    ]);

    // ── 2. Score every squad player ────────────────────────────────────────────
    // Signals: position value + prime-age bonus + shirt number (starter indicator)
    const POS_BASE  = { Attacker: 14, Midfielder: 11, Defender: 7, Goalkeeper: 6 };
    const POS_LABEL = {
      Attacker:   "Key attacking threat",
      Midfielder: "Creative midfield force",
      Defender:   "Solid defensive anchor",
      Goalkeeper: "Essential goalkeeper",
    };

    const scorePlayer = (raw, teamName) => {
      const pos = mapPos(raw);
      let score = POS_BASE[pos] || 7;
      const reasons = [];

      // Prime-age bonus (23–31 = peak football years)
      if (raw.dateOfBirth) {
        const age = Math.floor(
          (Date.now() - new Date(raw.dateOfBirth).getTime()) / (365.25 * 24 * 3600 * 1000)
        );
        if (age >= 23 && age <= 31) {
          score += 3;
          reasons.push(`Peak age (${age})`);
        } else if (age >= 20 && age <= 35) {
          score += 1;
        }
      }

      // Low shirt number = regular starter
      const shirt = raw.shirtNumber;
      if (shirt && shirt >= 1 && shirt <= 11) {
        score += 2;
        reasons.push("Regular starter");
      }

      // Always have at least one readable reason
      if (reasons.length === 0) reasons.push(POS_LABEL[pos]);
      reasons.push(POS_LABEL[pos]);

      return {
        name: raw.name,
        position: pos,
        team: teamName,
        score,
        reason: [...new Set(reasons)].join(" · ") + ` — ${teamName}`,
      };
    };

    // ── 3. Pick top 3 from each squad → exactly 6 total ───────────────────────
    const top3 = (squad, teamName) =>
      squad
        .map(p => scorePlayer(p, teamName))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

    const homeTop3 = top3(homeSquad, fdMatch.homeTeam.name);
    const awayTop3 = top3(awaySquad, fdMatch.awayTeam.name);
    const result   = [...homeTop3, ...awayTop3];

    console.log(`[Recs] ✅ ${result.length} picks → ${fdMatch.homeTeam.name} (${homeTop3.length}) + ${fdMatch.awayTeam.name} (${awayTop3.length})`);
    res.json({ success: true, recommendations: result });

  } catch (err) {
    console.error("[Recommendations] Error:", err.message);
    res.status(500).json({ error: "Failed to generate recommendations" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYER PROFILES (Detailed Stats)
// ═══════════════════════════════════════════════════════════════════════════════

const afPlayerProfileCache = {};

app.get("/api/player/:name", async (req, res) => {
  try {
    const rawName = req.params.name;
    const nameQuery = encodeURIComponent(rawName);
    
    const now = Date.now();
    if (afPlayerProfileCache[rawName] && now - afPlayerProfileCache[rawName].time < CACHE_1HR) {
      return res.json({ success: true, profile: afPlayerProfileCache[rawName].data });
    }

    // Since we are on a free plan, we cannot access 2026 data. We try 2022 World Cup.
    const data = await afFetch(`/players?search=${nameQuery}&league=1&season=2022`);
    
    let profile;
    
    if (data && data.response && data.response.length > 0) {
      // Find closest match or just use first result
      let bestMatch = data.response[0];
      for (const item of data.response) {
        if (teamNamesMatch(item.player.name, rawName) || teamNamesMatch(rawName, item.player.name)) {
           bestMatch = item; break;
        }
      }

      const p = bestMatch.player;
      const stats = bestMatch.statistics && bestMatch.statistics.length > 0 ? bestMatch.statistics[0] : {};

      profile = {
         id: p.id,
         name: p.name,
         firstname: p.firstname,
         lastname: p.lastname,
         age: p.age,
         nationality: p.nationality,
         height: p.height,
         weight: p.weight,
         photo: p.photo,
         team: stats.team?.name || 'Unknown',
         position: stats.games?.position || 'Unknown',
         rating: parseFloat(stats.games?.rating) || null,
         matches: stats.games?.appearences || 0,
         minutes: stats.games?.minutes || 0,
         goals: stats.goals?.total || 0,
         assists: stats.goals?.assists || 0,
         passes: stats.passes?.accuracy || 0,
         tackles: stats.tackles?.total || 0,
         saves: stats.goalkeeper?.saves || 0,
         yellowCards: stats.cards?.yellow || 0,
         redCards: stats.cards?.red || 0,
      };
    } else {
      // FALBACK: If player not in 2022 WC (e.g. Scotland), generate a realistic deterministic profile
      const seed = Array.from(rawName).reduce((sum, char) => sum + char.charCodeAt(0), 0);
      const prng = seededRng(seed);
      
      const isGk = seed % 10 === 0;
      const matches = Math.floor(prng() * 15) + 5;
      const isDefender = seed % 3 === 0;

      profile = {
         id: seed,
         name: rawName,
         age: Math.floor(prng() * 12) + 21,
         nationality: "International",
         height: Math.floor(prng() * 20) + 170 + " cm",
         photo: `https://ui-avatars.com/api/?name=${nameQuery}&background=random&color=fff&size=200`,
         team: "National Team",
         position: isGk ? "Goalkeeper" : isDefender ? "Defender" : seed % 2 === 0 ? "Midfielder" : "Attacker",
         rating: parseFloat((prng() * 2 + 6.5).toFixed(1)),
         matches: matches,
         minutes: matches * 80 + Math.floor(prng() * 50),
         goals: isGk ? 0 : Math.floor(prng() * (isDefender ? 3 : 15)),
         assists: isGk ? 0 : Math.floor(prng() * 10),
         passes: Math.floor(prng() * 20) + 75,
         saves: isGk ? Math.floor(prng() * 40) + 10 : 0,
         yellowCards: Math.floor(prng() * 5),
         redCards: Math.floor(prng() * 1),
      };
    }

    afPlayerProfileCache[rawName] = { data: profile, time: now };
    res.json({ success: true, profile });

  } catch (err) {
    console.error("[Player Profile] Error:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch player profile" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEAMS & POINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Wallet API ──────────────────────────────────────────────────────────────

// GET current wallet balance
app.get("/api/wallet", authMiddleware, async (req, res) => {
  const rows = await query('SELECT wallet FROM users WHERE id = ?', [req.userId]);
  if (rows.length === 0) return res.status(404).json({ success: false });
  res.json({ success: true, wallet: rows[0].wallet ?? 1000 });
});

// POST add funds to wallet
app.post("/api/wallet/add", authMiddleware, async (req, res) => {
  try {
    const { amount, password } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    // Verify password first
    const users = await query('SELECT password FROM users WHERE id = ?', [req.userId]);
    if (users.length === 0 || users[0].password !== password) {
      return res.status(401).json({ success: false, message: "Incorrect password" });
    }

    // Update wallet
    await query('UPDATE users SET wallet = wallet + ? WHERE id = ?', [amount, req.userId]);
    
    // Fetch updated wallet balance
    const updatedUser = await query('SELECT wallet FROM users WHERE id = ?', [req.userId]);
    res.json({ success: true, message: "Wallet successfully credited!", wallet: updatedUser[0].wallet });
  } catch (err) {
    console.error("[Wallet Add] Error:", err.message);
    res.status(500).json({ success: false, error: "Failed to add funds" });
  }
});

// GET user's contest entries
app.get("/api/contest-entries/:userId", async (req, res) => {
  const entries = await query('SELECT * FROM contest_entries WHERE user_id = ? ORDER BY created_at DESC', [req.params.userId]);
  res.json(entries);
});

// --- Core Logic for Settlements ---
async function settleMatchContest(matchId) {
  // Get all entries for this match that are still in 'entered' state
  const entries = await query(
    `SELECT ce.*, ut.simulated_points, ut.user_id
     FROM contest_entries ce
     JOIN user_teams ut ON ce.user_id = ut.user_id AND ce.match_id = ut.match_id
     WHERE ce.match_id = ? AND ce.status = 'entered'
     ORDER BY ut.simulated_points DESC`,
    [matchId]
  );

  if (entries.length === 0) return null;

  const winner = entries[0];
  // Award ₹200 to winner
  await query('UPDATE users SET wallet = wallet + 200 WHERE id = ?', [winner.user_id]);
  await query('UPDATE contest_entries SET status = ?, prize = 200 WHERE user_id = ? AND match_id = ?', ['won', winner.user_id, matchId]);

  // Mark all others as lost
  for (let i = 1; i < entries.length; i++) {
    await query('UPDATE contest_entries SET status = ? WHERE user_id = ? AND match_id = ?', ['lost', entries[i].user_id, matchId]);
  }

  return winner;
}

// POST /api/contest/settle/:matchId — manual override
app.post("/api/contest/settle/:matchId", authMiddleware, async (req, res) => {
  try {
    const matchId = parseInt(req.params.matchId);
    const winner = await settleMatchContest(matchId);
    if (!winner) {
      return res.json({ success: false, message: "No active entries for this match" });
    }
    res.json({ success: true, winner: winner.user_id, message: "Contest settled. Winner awarded ₹200." });
  } catch (err) {
    console.error("[Contest Settle] Error:", err.message);
    res.status(500).json({ success: false, error: "Failed to settle contest" });
  }
});

app.post("/api/teams", authMiddleware, async (req, res) => {
  const { matchId, teamName, players, captain, viceCaptain, formation } = req.body;
  // expects `players` array with {id, name, position, isStarter} (16 players: 11 starters + 5 subs)
  
  if (players.length !== 16) {
     return res.status(400).json({ success: false, message: "Team must have exactly 16 players (11 starters, 5 subs)." });
  }

  const matches = await fetchMatches();
  const fdMatch = matches.find((m) => m.id === parseInt(matchId));

  if (!fdMatch) return res.status(404).json({ success: false, message: "Match not found" });

  // EDIT LOCKOUT: block once the match has started or finished
  const lockedStatuses = ['IN_PLAY', 'PAUSED', 'FINISHED', 'SUSPENDED'];
  if (lockedStatuses.includes(fdMatch.status)) {
    return res.status(403).json({ success: false, message: "Teams are locked once the match has started." });
  }

  // Check if updating
  const existingTeams = await query('SELECT id FROM user_teams WHERE user_id = ? AND match_id = ?', [req.userId, matchId]);
  const isUpdate = existingTeams.length > 0;
  const teamId = isUpdate ? existingTeams[0].id : Date.now().toString();

  // ── Wallet / Contest Entry Logic ──────────────────────────────────────────
  // Only charge on first entry (not on edits). Check contest_entries table.
  const existingEntry = await query('SELECT id FROM contest_entries WHERE user_id = ? AND match_id = ?', [req.userId, matchId]);
  const isFirstEntry = existingEntry.length === 0;

  if (isFirstEntry) {
    // Check user has enough balance
    const userRows = await query('SELECT wallet FROM users WHERE id = ?', [req.userId]);
    const currentWallet = userRows[0]?.wallet ?? 1000;
    if (currentWallet < 100) {
      return res.status(400).json({ success: false, message: "Insufficient balance. You need ₹100 to enter this contest." });
    }
    // Deduct ₹100 entry fee
    await query('UPDATE users SET wallet = wallet - 100 WHERE id = ?', [req.userId]);
    // Create contest entry record
    await query(
      'INSERT INTO contest_entries (id, user_id, match_id, entry_fee, status, created_at) VALUES (?, ?, ?, 100, "entered", ?)',
      [Date.now().toString() + req.userId, req.userId, matchId, new Date()]
    );
  }

  // Fetch updated wallet to return to client
  const updatedUser = await query('SELECT wallet FROM users WHERE id = ?', [req.userId]);
  const newWallet = updatedUser[0]?.wallet ?? 1000;

  let breakdown, totalPoints;
  let realStats = false;

  try {
    if (fdMatch?.status === "FINISHED") {
      const real = await buildRealBreakdown({ players, captain, viceCaptain, matchId }, fdMatch);
      if (real) {
        breakdown   = real.breakdown;
        totalPoints = real.totalPoints;
        realStats   = true;
      }
    }
  } catch (err) {}

  if (!breakdown) {
    const sim  = generateSimulatedBreakdown(players, captain, viceCaptain, matchId + teamName);
    breakdown   = sim.breakdown;
    totalPoints = sim.totalPoints;
  }

  if (isUpdate) {
     await query(`
       UPDATE user_teams 
       SET team_name=?, formation=?, captain=?, vice_captain=?, simulated_points=?, points_breakdown=?, real_stats=?, players=?
       WHERE id=?
     `, [teamName, formation, captain, viceCaptain, totalPoints, JSON.stringify(breakdown), realStats, JSON.stringify(players), teamId]);
  } else {
     await query(`
       INSERT INTO user_teams (id, user_id, match_id, team_name, formation, captain, vice_captain, simulated_points, points_breakdown, real_stats, players, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     `, [teamId, req.userId, matchId, teamName || "Dream Team", formation, captain, viceCaptain, totalPoints, JSON.stringify(breakdown), realStats, JSON.stringify(players), new Date()]);
  }

  res.json({ 
    success: true, 
    message: isUpdate ? "Team updated!" : "Team saved! ₹100 entry fee charged.",
    wallet: newWallet,
    isFirstEntry
  });
});

app.get("/api/teams/user/:userId", async (req, res) => {
  const teams = await query('SELECT * FROM user_teams WHERE user_id = ? ORDER BY created_at DESC', [req.params.userId]);
  // Parse JSON fields
  teams.forEach(t => {
     t.pointsBreakdown = t.points_breakdown;
     delete t.points_breakdown;
  });
  res.json(teams);
});

async function syncRealStatsGlobally() {
  const teams = await query('SELECT * FROM user_teams WHERE real_stats = FALSE');
  const matches = await fetchMatches();
  let updated = 0;

  for (let i = 0; i < teams.length; i++) {
    const team  = teams[i];
    const fdMatch = matches.find((m) => m.id === team.match_id);
    if (!fdMatch || fdMatch.status !== "FINISHED") continue;

    team.players = typeof team.players === 'string' ? JSON.parse(team.players) : team.players;
    
    const real = await buildRealBreakdown(team, fdMatch);
    if (!real) continue;

    await query('UPDATE user_teams SET simulated_points=?, points_breakdown=?, real_stats=TRUE WHERE id=?', 
      [real.totalPoints, JSON.stringify(real.breakdown), team.id]);
    updated++;
  }
  return updated;
}

app.post("/api/teams/sync-real-stats", async (req, res) => {
  try {
    const updated = await syncRealStatsGlobally();
    res.json({ success: true, updated, message: `Synced real stats for ${updated} team(s).` });
  } catch (err) {
    res.status(500).json({ error: "Sync failed" });
  }
});

// Leaderboard
app.get("/api/points/leaderboard", async (req, res) => {
  const userStats = await query(`
    SELECT u.id, u.username, u.premium_until,
           SUM(t.simulated_points) as points, COUNT(t.id) as teamsCount
    FROM users u
    JOIN user_teams t ON u.id = t.user_id
    GROUP BY u.id, u.username, u.premium_until
    ORDER BY points DESC
    LIMIT 50
  `);

  userStats.forEach(u => {
     u.isPremium = u.premium_until && new Date(u.premium_until) > new Date();
  });

  res.json(userStats);
});

app.get("/api/points/leaderboard/matches", async (req, res) => {
  const matches = await fetchMatches();
  const teams = await query(`
    SELECT t.*, u.username, u.premium_until 
    FROM user_teams t 
    JOIN users u ON t.user_id = u.id
  `);
  
  const matchContests = [];
  const teamsByMatch = {};
  teams.forEach(t => {
     if (!teamsByMatch[t.match_id]) teamsByMatch[t.match_id] = [];
     teamsByMatch[t.match_id].push(t);
  });

  for (const matchIdStr in teamsByMatch) {
    const matchId = parseInt(matchIdStr);
    const match = matches.find((m) => m.id === matchId);
    if (!match) continue;

    const contestTeams = teamsByMatch[matchId];
    let contestLeaderboard = contestTeams.map(t => ({
      userId: t.user_id,
      username: t.username,
      isPremium: t.premium_until && new Date(t.premium_until) > new Date(),
      teamName: t.team_name,
      points: match.status === 'FINISHED' ? t.simulated_points : null,
    }));

    if (match.status === 'FINISHED') contestLeaderboard.sort((a, b) => b.points - a.points);
    else contestLeaderboard.sort((a, b) => a.username.localeCompare(b.username));

    matchContests.push({
      matchId: match.id,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
      date: match.date,
      status: match.status,
      leaderboard: contestLeaderboard
    });
  }
  matchContests.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(matchContests);
});

// GET user specific points & stats
app.get("/api/points/user/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Basic stats
    const basicStats = await query(`
      SELECT 
        SUM(simulated_points) as totalPoints,
        COUNT(id) as teamsCount,
        COUNT(DISTINCT match_id) as matchesPlayed
      FROM user_teams
      WHERE user_id = ?
    `, [userId]);

    const totalPoints = basicStats[0]?.totalPoints || 0;
    const teamsCount = basicStats[0]?.teamsCount || 0;
    const matchesPlayed = basicStats[0]?.matchesPlayed || 0;

    // Calculate best rank
    let bestRank = null;
    const userMatches = await query(`SELECT DISTINCT match_id FROM user_teams WHERE user_id = ?`, [userId]);
    
    if (userMatches.length > 0) {
      const matchIds = userMatches.map(m => m.match_id);
      const allTeamsInTheseMatches = await query(`
        SELECT match_id, user_id, simulated_points 
        FROM user_teams 
        WHERE match_id IN (?)
      `, [matchIds]);

      const matches = await fetchMatches();

      const teamsByMatch = {};
      allTeamsInTheseMatches.forEach(t => {
        if (!teamsByMatch[t.match_id]) teamsByMatch[t.match_id] = [];
        teamsByMatch[t.match_id].push(t);
      });

      for (const matchIdStr in teamsByMatch) {
        const matchId = parseInt(matchIdStr);
        const match = matches.find((m) => m.id === matchId);
        // Only rank if match is FINISHED
        if (!match || match.status !== 'FINISHED') continue;

        const contestTeams = teamsByMatch[matchId];
        // Sort teams by points DESC
        contestTeams.sort((a, b) => b.simulated_points - a.simulated_points);
        
        // Find user rank
        const rankIndex = contestTeams.findIndex(t => t.user_id === userId);
        if (rankIndex !== -1) {
          const rank = rankIndex + 1;
          if (bestRank === null || rank < bestRank) {
            bestRank = rank;
          }
        }
      }
    }

    res.json({
      totalPoints,
      teamsCount,
      matchesPlayed,
      bestRank
    });
  } catch (err) {
    console.error("[User Points] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch user points" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LINEUP SYSTEM — api-football integration
// ═══════════════════════════════════════════════════════════════════════════════

// Fetch lineup for a specific FD match and store it in DB
async function fetchAndStoreLineup(fdMatch) {
  const fdMatchId = fdMatch.id;
  try {
    const afFixture = await findAfFixture(fdMatch);

    if (!afFixture) {
      console.log(`[AF Lineup] No AF fixture found for FD match ${fdMatchId} (${fdMatch.homeTeam.name} vs ${fdMatch.awayTeam.name})`);
      return null;
    }

    const afFixtureId = afFixture.fixture.id;
    const lineupData = await afFetch(`/fixtures/lineups?fixture=${afFixtureId}`);

    if (!lineupData.response || lineupData.response.length === 0) {
      console.log(`[AF Lineup] Empty lineup for match ${fdMatchId} — not yet confirmed`);
      return null;
    }

    const extractNames = (arr) => (arr || []).map(p => p.player?.name).filter(Boolean);

    let homeLineup = [], homeSubs = [], awayLineup = [], awaySubs = [];

    lineupData.response.forEach(teamData => {
      const isHome = teamNamesMatch(teamData.team.name, fdMatch.homeTeam.name);
      if (isHome) {
        homeLineup = extractNames(teamData.startXI);
        homeSubs = extractNames(teamData.substitutes);
      } else {
        awayLineup = extractNames(teamData.startXI);
        awaySubs = extractNames(teamData.substitutes);
      }
    });

    if (homeLineup.length === 0 && awayLineup.length === 0) {
      console.log(`[AF Lineup] Empty lineup for match ${fdMatchId} — not yet confirmed`);
      return null;
    }

    // Upsert into DB
    await query(`
      INSERT INTO match_lineups (match_id, home_lineup, home_subs, away_lineup, away_subs, confirmed_at, source)
      VALUES (?, ?, ?, ?, ?, NOW(), 'api-football')
      ON DUPLICATE KEY UPDATE
        home_lineup = VALUES(home_lineup),
        home_subs   = VALUES(home_subs),
        away_lineup = VALUES(away_lineup),
        away_subs   = VALUES(away_subs),
        confirmed_at = VALUES(confirmed_at),
        source = VALUES(source)
    `, [fdMatchId, JSON.stringify(homeLineup), JSON.stringify(homeSubs), JSON.stringify(awayLineup), JSON.stringify(awaySubs)]);

    console.log(`[AF Lineup] ✅ Stored lineup for match ${fdMatchId}: ${fdMatch.homeTeam.name}(${homeLineup.length}) vs ${fdMatch.awayTeam.name}(${awayLineup.length})`);
    return { homeLineup, homeSubs, awayLineup, awaySubs };
  } catch (err) {
    console.error(`[AF Lineup] Error for match ${fdMatchId}:`, err.message);
    return null;
  }
}

// Background polling job — runs every 10 minutes
// Checks matches starting within the next 3 hours that don't have a lineup yet
async function pollUpcomingLineups() {
  try {
    const matches = await fetchMatches();
    const now = Date.now();
    const THREE_HOURS = 3 * 60 * 60 * 1000;

    const upcoming = matches.filter(m => {
      if (m.status === 'FINISHED') return false;
      const matchTime = new Date(m.date).getTime();
      const diff = matchTime - now;
      return diff > 0 && diff <= THREE_HOURS;
    });

    if (upcoming.length === 0) return;

    // Check which ones already have a lineup
    const existingRows = await query(
      `SELECT match_id FROM match_lineups WHERE match_id IN (?)`,
      [upcoming.map(m => m.id)]
    );
    const alreadyHave = new Set(existingRows.map(r => r.match_id));

    const toFetch = upcoming.filter(m => !alreadyHave.has(m.id));
    if (toFetch.length === 0) return;

    console.log(`[Lineup Poll] Checking ${toFetch.length} upcoming match(es) for confirmed lineups...`);
    for (const match of toFetch) {
      await fetchAndStoreLineup(match);
      await new Promise(r => setTimeout(r, 1500)); // small delay between requests
    }
  } catch (err) {
    console.error("[Lineup Poll] Error:", err.message);
  }
}

// GET /api/lineup/:matchId — returns stored lineup or null
app.get("/api/lineup/:matchId", async (req, res) => {
  const matchId = parseInt(req.params.matchId);
  const rows = await query('SELECT * FROM match_lineups WHERE match_id = ?', [matchId]);
  if (rows.length === 0) return res.json({ available: false, matchId });

  const row = rows[0];
  const parse = v => {
    if (Array.isArray(v)) return v;
    try { return JSON.parse(v); } catch { return []; }
  };

  res.json({
    available: true,
    matchId,
    confirmedAt: row.confirmed_at,
    source: row.source,
    home: {
      lineup: parse(row.home_lineup),
      subs:   parse(row.home_subs),
    },
    away: {
      lineup: parse(row.away_lineup),
      subs:   parse(row.away_subs),
    },
  });
});

// POST /api/lineup/fetch/:matchId — manual trigger (useful for testing with finished matches)
app.post("/api/lineup/fetch/:matchId", authMiddleware, async (req, res) => {
  const matchId = parseInt(req.params.matchId);
  const matches = await fetchMatches();
  const fdMatch = matches.find(m => m.id === matchId);
  if (!fdMatch) return res.status(404).json({ error: "Match not found" });

  const result = await fetchAndStoreLineup(fdMatch);
  if (result) {
    res.json({ success: true, message: "Lineup fetched and stored.", ...result });
  } else {
    res.json({ success: false, message: "Lineup not yet available from TheStatsAPI." });
  }
});

// Start background lineup polling (every 10 minutes)
setInterval(pollUpcomingLineups, 10 * 60 * 1000);

// Auto-settlement job
async function autoSettleFinishedMatches() {
  try {
    // 1. Sync real stats for finished matches
    await syncRealStatsGlobally();

    // 2. Identify active contests that can be settled
    const activeContests = await query("SELECT DISTINCT match_id FROM contest_entries WHERE status = 'entered'");
    const matches = await fetchMatches();

    for (let i = 0; i < activeContests.length; i++) {
      const matchId = activeContests[i].match_id;
      const fdMatch = matches.find((m) => m.id === matchId);
      if (!fdMatch || fdMatch.status !== "FINISHED") continue;

      // Ensure all teams for this match have real_stats = TRUE
      const unsyncedTeams = await query("SELECT id FROM user_teams WHERE match_id = ? AND real_stats = FALSE", [matchId]);
      if (unsyncedTeams.length > 0) {
        console.log(`[Auto Settle] Match ${matchId} has ${unsyncedTeams.length} unsynced team(s), skipping settlement for now.`);
        continue;
      }

      console.log(`[Auto Settle] Settling match ${matchId}...`);
      const winner = await settleMatchContest(matchId);
      if (winner) {
        console.log(`[Auto Settle] Match ${matchId} settled! Winner: User ${winner.user_id} with ${winner.simulated_points} pts.`);
      }
    }
  } catch (err) {
    console.error("[Auto Settle] Error:", err.message);
  }
}

// Check every 5 minutes
setInterval(autoSettleFinishedMatches, 5 * 60 * 1000);

app.listen(5000, async () => {
  console.log("⚽ FIFA World Cup 2026 Backend running on http://localhost:5000");
  console.log("📡 connected to MySQL via db.js");
  // Initial lineup poll & settlement check on startup
  setTimeout(pollUpcomingLineups, 5000);
  setTimeout(autoSettleFinishedMatches, 6000);
});
