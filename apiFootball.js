const API_KEY = "0df5297fded38ef10b3a2a27646bb59f";
const BASE_URL = "https://v3.football.api-sports.io";

// Cache durations
const MATCH_CACHE_MS = 60 * 1000; // 1 minute for live matches
const SQUAD_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours for squads

export async function apiFetch(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { "x-apisports-key": API_KEY }
  });
  return res.json();
}

// Fetch all World Cup 2022 fixtures
export async function getWorldCupFixtures() {
  const data = await apiFetch("/fixtures?league=1&season=2022");
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.error("API Error:", data.errors);
    return [];
  }
  return data.response || [];
}

// Fetch squad for a specific team
export async function getTeamSquad(teamId) {
  const data = await apiFetch(`/players/squads?team=${teamId}`);
  if (data.response && data.response.length > 0) {
    return data.response[0];
  }
  return null;
}

// Map API status to our internal status
export function mapFixtureStatus(apiStatus) {
  switch (apiStatus) {
    case "FT": case "AET": case "PEN": return "FT";
    case "NS": case "TBD": return "UPCOMING";
    case "1H": case "2H": case "HT": case "ET": case "BT": case "P": case "SUSP": case "INT": case "LIVE": return "LIVE";
    default: return "UPCOMING";
  }
}

// Map API position to our short format
export function mapPosition(apiPos) {
  switch (apiPos) {
    case "Goalkeeper": return "GK";
    case "Defender": return "DEF";
    case "Midfielder": return "MID";
    case "Attacker": return "FWD";
    default: return "MID";
  }
}

// Assign a credit value based on position (simple algorithm)
export function assignCredit(position) {
  switch (position) {
    case "GK": return 7.0 + Math.round(Math.random() * 20) / 10;
    case "DEF": return 7.0 + Math.round(Math.random() * 25) / 10;
    case "MID": return 7.5 + Math.round(Math.random() * 30) / 10;
    case "FWD": return 8.0 + Math.round(Math.random() * 40) / 10;
    default: return 7.5;
  }
}
