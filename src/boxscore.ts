/**
 * Per-game box score fetcher + parser.
 *
 * The boxscore endpoint covers leagues where ESPN ships a single flat
 * stats block per team (NBA family) or multiple sub-blocks per team
 * (NHL: forwards / defenses / skaters / goalies). NFL and MLB ship
 * multi-category data on their boxscore that this parser doesn't
 * flatten yet — use the gamelog endpoint for those instead.
 *
 * The shape returned by this module reuses `BoxScorePlayer` /
 * `BoxScoreTeam` from `@buzzr/dfs-engine` so downstream callers can
 * pipe directly into `boxScorePlayerToGameLogShape` /
 * `findAndConvertBoxScorePlayer`.
 */
import type { BoxScorePlayer, BoxScoreTeam } from '@buzzr/dfs-engine';
import { DEFAULT_FETCH_TIMEOUT_MS, ESPN_BASE_URL, ESPN_SPORT_PATHS } from './constants';

const MULTI_BLOCK_LEAGUES = new Set<string>(['NHL']);

export type BoxScoreState = 'pre' | 'in' | 'post';

export interface BoxScore {
  /** 'pre' game scheduled, 'in' live, 'post' final. */
  state: BoxScoreState;
  /** Period / quarter; 1..4 regulation, 5+ overtime, null pre-game. */
  period: number | null;
  /** Raw clock string from ESPN. UI display only. */
  displayClock: string | null;
  awayTeam: BoxScoreTeam;
  homeTeam: BoxScoreTeam;
}

export interface FetchBoxScoreOptions {
  /** Custom fetch implementation (override for caching / proxying). */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Default 10s. */
  timeoutMs?: number;
}

/**
 * Fetch per-player boxscore for an ESPN game. Returns null on:
 *   - league outside supported coverage
 *   - empty event id
 *   - network timeout / non-2xx response
 *   - unparseable response shape
 *
 * Never throws. Designed for cron-friendly use where a null return is
 * just "try again next tick."
 */
export async function fetchGameBoxScore(
  league: string,
  espnEventId: string,
  opts: FetchBoxScoreOptions = {},
): Promise<BoxScore | null> {
  if (!espnEventId) return null;
  const sportPath = ESPN_SPORT_PATHS[league.toUpperCase()];
  if (!sportPath) return null;

  const f = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${ESPN_BASE_URL}/${sportPath}/summary?event=${encodeURIComponent(espnEventId)}`,
      f,
      timeoutMs,
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return null;
  }

  return parseBoxScore(data, league.toUpperCase());
}

/**
 * Parse a raw ESPN summary JSON into a BoxScore. Exported for testing
 * and for callers that already have the response from a cached/proxied
 * source.
 */
export function parseBoxScore(data: unknown, league: string): BoxScore | null {
  if (!isRecord(data)) return null;
  const boxscore = isRecord(data.boxscore) ? data.boxscore : undefined;
  const teams = Array.isArray(boxscore?.players) ? (boxscore.players as unknown[]) : [];
  if (teams.length < 2) return null;

  // ESPN's `boxscore.players[]` is NOT in the same order as
  // `header.competitions[0].competitors[]`. Boxscore usually ships
  // [away, home] while header ships [home, away]. Match by team id,
  // not by index. Verified May 2026.
  const homeAwayByTeamId = readHomeAwayByTeamId(data);
  const block0 = parseTeam(teams[0], league);
  const block1 = parseTeam(teams[1], league);

  let awayTeam = block0;
  let homeTeam = block1;
  const side0 = homeAwayByTeamId.get(block0.teamId);
  const side1 = homeAwayByTeamId.get(block1.teamId);
  if (side0 === 'home' || side1 === 'away') {
    homeTeam = block0;
    awayTeam = block1;
  }

  return {
    state: parseState(data),
    period: parsePeriod(data),
    displayClock: parseDisplayClock(data),
    awayTeam,
    homeTeam,
  };
}

/* ────────────────────────────────────────────────────────────────────
 * Internals
 * ────────────────────────────────────────────────────────────────── */

async function fetchWithTimeout(
  url: string,
  f: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await f(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readHomeAwayByTeamId(data: Record<string, unknown>): Map<string, 'home' | 'away'> {
  const header = isRecord(data.header) ? data.header : undefined;
  const competitions = Array.isArray(header?.competitions)
    ? (header.competitions as unknown[])
    : [];
  const firstComp = isRecord(competitions[0]) ? competitions[0] : undefined;
  const competitors = Array.isArray(firstComp?.competitors)
    ? (firstComp.competitors as unknown[])
    : [];
  const out = new Map<string, 'home' | 'away'>();
  for (const c of competitors) {
    if (!isRecord(c)) continue;
    const team = isRecord(c.team) ? c.team : undefined;
    const id = typeof team?.id === 'string' ? team.id : null;
    if (!id) continue;
    if (c.homeAway === 'home') out.set(id, 'home');
    else if (c.homeAway === 'away') out.set(id, 'away');
  }
  return out;
}

function parseState(data: Record<string, unknown>): BoxScoreState {
  const raw = drillStatus(data)?.state;
  if (raw === 'in' || raw === 'post' || raw === 'pre') return raw;
  return 'pre';
}

function parsePeriod(data: Record<string, unknown>): number | null {
  const raw = drillStatus(data)?.period;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return raw;
  return null;
}

function parseDisplayClock(data: Record<string, unknown>): string | null {
  const raw = drillStatus(data)?.displayClock;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

function drillStatus(
  data: Record<string, unknown>,
): { state?: unknown; period?: unknown; displayClock?: unknown } | null {
  const header = isRecord(data.header) ? data.header : undefined;
  const competitions = Array.isArray(header?.competitions) ? header.competitions : [];
  const firstComp = isRecord(competitions[0]) ? competitions[0] : undefined;
  const status = isRecord(firstComp?.status) ? firstComp.status : undefined;
  if (!status) return null;
  const type = isRecord(status.type) ? status.type : undefined;
  return {
    state: type?.state,
    period: status.period,
    displayClock: status.displayClock,
  };
}

function parseTeam(block: unknown, league: string): BoxScoreTeam {
  if (!isRecord(block)) return { teamId: '', players: [] };
  const teamMeta = isRecord(block.team) ? block.team : undefined;
  const teamId = typeof teamMeta?.id === 'string' ? teamMeta.id : '';

  const statBlocks = Array.isArray(block.statistics) ? (block.statistics as unknown[]) : [];
  const players: BoxScorePlayer[] = [];
  if (statBlocks.length === 0) return { teamId, players };

  const isMultiBlock = MULTI_BLOCK_LEAGUES.has(league);
  const blocksToWalk = isMultiBlock ? statBlocks : statBlocks.slice(0, 1);

  for (const rawBlock of blocksToWalk) {
    if (!isRecord(rawBlock)) continue;
    const namesField = Array.isArray(rawBlock.names) ? (rawBlock.names as string[]) : [];
    const labelsField = Array.isArray(rawBlock.labels) ? (rawBlock.labels as string[]) : [];
    const labels = namesField.length > 0 ? namesField : labelsField;
    if (labels.length === 0) continue;

    const athletes = Array.isArray(rawBlock.athletes) ? (rawBlock.athletes as unknown[]) : [];
    for (const ath of athletes) {
      if (!isRecord(ath)) continue;
      const athlete = isRecord(ath.athlete) ? ath.athlete : undefined;
      const name = typeof athlete?.displayName === 'string' ? athlete.displayName : '';
      if (!name) continue;
      const athleteId = typeof athlete?.id === 'string' ? athlete.id : '';
      const rawStats = Array.isArray(ath.stats) ? (ath.stats as unknown[]) : [];
      const stats: Record<string, string> = {};
      labels.forEach((label, i) => {
        const v = rawStats[i];
        if (typeof v === 'string') stats[label] = v;
      });
      players.push({ athleteId, name, stats });
    }
  }

  return { teamId, players };
}
