/**
 * Server-safe ESPN injury-status fetcher — Deno-only.
 *
 * Mirror of fetchInjuryStatus + INJURY_STATUS_MAP from
 *   src/features/games/services/player-gamelog-service.ts
 * without the React-Native cache wrapper. The bet-dfs-settlement-watcher
 * pre-game DNP pass uses this to look up athlete status near tipoff;
 * a request-lifetime cache keyed by (athleteId, league) is owned by
 * the caller.
 *
 * Endpoint: https://site.web.api.espn.com/apis/common/v3/sports/{sportPath}/athletes/{athleteId}
 * The athlete profile response includes a `status` object whose `type`
 * (or `name`) field maps to one of our InjuryStatus values.
 *
 * If either the upstream map or the URL shape changes, mirror the
 * change into the RN-side service so the two paths don't drift.
 */

const ESPN_BASE = 'https://site.web.api.espn.com/apis/common/v3/sports';
const FETCH_TIMEOUT_MS = 10_000;

const SPORT_PATHS: Record<string, string> = {
  NBA: 'basketball/nba',
  WNBA: 'basketball/wnba',
  NCAAM: 'basketball/mens-college-basketball',
  NCAAW: 'basketball/womens-college-basketball',
  NFL: 'football/nfl',
  MLB: 'baseball/mlb',
  NHL: 'hockey/nhl',
};

export type InjuryStatus =
  | 'Active'
  | 'Questionable'
  | 'Doubtful'
  | 'Out'
  | 'IR'
  | 'Day-To-Day';

const INJURY_STATUS_MAP: Record<string, InjuryStatus> = {
  active: 'Active',
  questionable: 'Questionable',
  doubtful: 'Doubtful',
  out: 'Out',
  injuredreserve: 'IR',
  ir: 'IR',
  daytoday: 'Day-To-Day',
  'day-to-day': 'Day-To-Day',
};

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch an athlete's injury status from ESPN. Returns null on any
 * fetch / parse failure or unrecognized status — caller should treat
 * null as "no auto-DNP signal, leave the leg pending."
 */
export async function fetchInjuryStatus(
  athleteId: string,
  league: string,
): Promise<InjuryStatus | null> {
  const sportPath = SPORT_PATHS[league.toUpperCase()];
  if (!sportPath) return null;

  const url = `${ESPN_BASE}/${sportPath}/athletes/${athleteId}`;
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    const athlete = (data.athlete ?? data) as Record<string, unknown>;
    const status = (athlete.status as Record<string, unknown> | null) ?? null;
    if (!status) return null;
    const typeStr = (
      (status.type as string | undefined) ??
      (status.name as string | undefined) ??
      ''
    )
      .toLowerCase()
      .replace(/\s/g, '');
    return INJURY_STATUS_MAP[typeStr] ?? null;
  } catch {
    return null;
  }
}

/**
 * Heuristic: which statuses cause an auto-DNP in the pre-game pass.
 * 'Out' and 'IR' only — Doubtful and Day-To-Day are too noisy
 * (Doubtful flips to active at gametime regularly). Mid-game DNP
 * detection (Phase E.mid) covers the noisy statuses via min-played
 * + final-game state.
 */
export function isAutoDnpStatus(status: InjuryStatus | null): boolean {
  return status === 'Out' || status === 'IR';
}
