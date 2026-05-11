/**
 * ESPN endpoint constants. Re-exported for callers building their own
 * URLs or using non-standard paths.
 *
 * ESPN's site API is undocumented but stable since ~2020. The paths
 * below are empirically reverse-engineered; if a sport's path changes,
 * override via the per-request options where supported.
 */

export const ESPN_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports';

export const ESPN_SPORT_PATHS: Readonly<Record<string, string>> = {
  NBA: 'basketball/nba',
  WNBA: 'basketball/wnba',
  NCAAM: 'basketball/mens-college-basketball',
  NCAAW: 'basketball/womens-college-basketball',
  NFL: 'football/nfl',
  NCAAF: 'football/college-football',
  MLB: 'baseball/mlb',
  NHL: 'hockey/nhl',
  EPL: 'soccer/eng.1',
  MLS: 'soccer/usa.1',
  LALIGA: 'soccer/esp.1',
  NWSL: 'soccer/usa.nwsl',
  UCL: 'soccer/uefa.champions',
};

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
