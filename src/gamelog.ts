/**
 * Server-safe ESPN gamelog fetcher — Deno-only.
 *
 * Mirrors the data extraction logic from
 *   src/features/games/services/player-gamelog-service.ts
 * but without the React-Native `mmkv-store`-backed cache (which can't
 * run in Deno). The settlement watcher needs gamelogs once per cron
 * tick — request-lifetime dedup is handled by the caller, no
 * persistent cache here.
 *
 * Coverage: NBA / WNBA / NCAAM (flat per-game stats). MLB returns
 * remapped fields (points=H/SO, rebounds=HR/IP, assists=RBI/ER) to
 * match the upstream parser. NFL gamelogs use a multi-category shape
 * that this fetcher does NOT expose yet — Phase B's parser refactor
 * lands that.
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

export type PlayerGameLogCategories = {
  passing?: Record<string, string>;
  rushing?: Record<string, string>;
  receiving?: Record<string, string>;
  defensive?: Record<string, string>;
};

export type PlayerGameLogMlbExtras = {
  singles?: string;
  doubles?: string;
  triples?: string;
  runs?: string;
  pitchesThrown?: string;
};

export interface PlayerGameLogEntry {
  date: string;
  opponent: string;
  homeAway: 'H' | 'A';
  result: 'W' | 'L' | '-';
  score: string;
  minutes: string;
  points: string;
  rebounds: string;
  assists: string;
  steals: string;
  blocks: string;
  turnovers: string;
  fg: string;
  threeP: string;
  ft: string;
  plusMinus: string;
  categories?: PlayerGameLogCategories;
  mlbRole?: 'batter' | 'pitcher' | null;
  mlbExtras?: PlayerGameLogMlbExtras;
  // NHL-only position discriminator. Mirrors mlbRole's pattern. See RN
  // copy of PlayerGameLogEntry for full comment. Absent on non-NHL rows.
  nhlPosition?: 'skater' | 'goalie' | null;
}

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
 * Fetch a player's gamelog from ESPN. Returns up to 20 most recent
 * entries (sorted newest-first). Returns an empty array on any
 * fetch / parse failure — caller should treat empty as "no data,
 * skip leg, retry next tick."
 */
export async function fetchPlayerGamelog(
  athleteId: string,
  league: string,
): Promise<PlayerGameLogEntry[]> {
  const sportPath = SPORT_PATHS[league.toUpperCase()];
  if (!sportPath) return [];

  const url = `${ESPN_BASE}/${sportPath}/athletes/${athleteId}/gamelog`;
  try {
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) return [];
    const data = (await resp.json()) as Record<string, unknown>;
    return parseGamelog(data, league);
  } catch {
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────
 * NFL category extraction — mirror of player-gamelog-service.ts
 * helpers. ESPN ships labels-section meta at top-level
 * `data.categories` (e.g. [{name:'passing',count:11},
 * {name:'rushing',count:5}]). We slice the labels array using those
 * counts directly. Unknown categories (e.g. "fumbles") advance the
 * cursor without producing a section.
 * ────────────────────────────────────────────────────────────────── */

type NflCategory = 'passing' | 'rushing' | 'receiving' | 'defensive';

const NFL_CATEGORY_META_MAP: Record<string, NflCategory> = {
  passing: 'passing',
  rushing: 'rushing',
  receiving: 'receiving',
  defensive: 'defensive',
  defense: 'defensive',
};

type NflLabelSection = { category: NflCategory; startIdx: number; endIdx: number };

export function buildNflLabelSections(
  metaCategories: ReadonlyArray<Record<string, unknown>>,
): NflLabelSection[] {
  const sections: NflLabelSection[] = [];
  let cursor = 0;
  for (const cat of metaCategories) {
    const rawName = typeof cat.name === 'string' ? cat.name.toLowerCase() : '';
    const count = typeof cat.count === 'number' && cat.count > 0 ? cat.count : 0;
    if (count === 0) continue;
    const known = NFL_CATEGORY_META_MAP[rawName];
    if (known) {
      sections.push({ category: known, startIdx: cursor, endIdx: cursor + count - 1 });
    }
    cursor += count;
  }
  return sections;
}

function buildNflCategories(
  sections: NflLabelSection[],
  labels: string[],
  stats: string[],
): { passing?: Record<string, string>; rushing?: Record<string, string>; receiving?: Record<string, string>; defensive?: Record<string, string> } {
  const out: { passing?: Record<string, string>; rushing?: Record<string, string>; receiving?: Record<string, string>; defensive?: Record<string, string> } = {};
  for (const section of sections) {
    const bucket: Record<string, string> = {};
    for (let i = section.startIdx; i <= section.endIdx && i < stats.length; i += 1) {
      bucket[labels[i]] = stats[i];
    }
    out[section.category] = bucket;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────
 * parseGamelog — port of src/features/games/services/player-gamelog-service.ts
 * Only the entries[] portion (no averages computation — settlement
 * grader doesn't need them).
 * ────────────────────────────────────────────────────────────────── */

function parseGamelog(
  data: Record<string, unknown>,
  league: string,
): PlayerGameLogEntry[] {
  // ESPN's athlete gamelog ships short-form labels under `data.labels`
  // (e.g. ['G','A','PTS','+/-',...]) and long-form names under
  // `data.names` (['goals','assists','points','plusMinus',...]).
  // Per-league branches below look up by short-form label
  // (`getByLabel('G')`), so we MUST read `data.labels` first. Falling
  // through to `data.names` is a defensive fallback for endpoints
  // that ship only one — but inverting the priority would silently
  // turn every gamelog row into '-' (the lookup wouldn't find 'G' in
  // ['goals','assists',...]). Verified live 2026-05.
  const labelsRaw = (data.labels ?? data.names ?? []) as string[];
  const labels: string[] = Array.isArray(labelsRaw) ? labelsRaw : [];
  const entries: PlayerGameLogEntry[] = [];

  const eventsMeta = (data.events ?? {}) as Record<string, Record<string, unknown>>;
  const seasonTypes = (data.seasonTypes ?? []) as Array<Record<string, unknown>>;
  if (seasonTypes.length === 0) return entries;

  const isMLB = league === 'MLB';
  const isMLBPitcher = isMLB && labels.some((l) => l === 'ERA' || l === 'IP');
  const isNFL = league === 'NFL';
  const metaCategories = (data.categories as Array<Record<string, unknown>> | undefined) ?? [];
  const nflSections = isNFL ? buildNflLabelSections(metaCategories) : null;

  // NHL skater/goalie discriminator. Mirror of RN parser; keep in sync.
  // Goalie endpoint ships 'SV' / 'SV%' labels; skater endpoint ships
  // 'S' / 'PPG' / 'PPA' / 'TOI/G' (verified live 2026-05). Hits and
  // Blocked Shots aren't on this endpoint — those legs route through
  // the watcher's SOURCE_OF_TRUTH boxscore-fallback instead.
  const isNHL = league === 'NHL';
  const isNHLGoalie = isNHL && labels.some((l) => l === 'SV' || l === 'SV%');

  for (const seasonType of seasonTypes) {
    const categories = (seasonType.categories ?? []) as Array<Record<string, unknown>>;
    for (const cat of categories) {
      const catEvents = (cat.events ?? []) as Array<Record<string, unknown>>;
      for (const event of catEvents) {
        const eventId = String(event.eventId ?? event.id ?? '');
        const stats = (event.stats ?? []) as string[];
        const meta = eventsMeta[eventId] ?? {};

        const opponent = (meta.opponent as Record<string, unknown>) ?? {};
        const opponentName =
          (opponent.displayName as string) ?? (opponent.abbreviation as string) ?? '?';
        const gameDate = (meta.gameDate as string) ?? '';
        const gameResult = (meta.gameResult as string) ?? '-';
        const atVs = (meta.atVs as string) ?? '';
        const homeScore = String(meta.homeTeamScore ?? '');
        const awayScore = String(meta.awayTeamScore ?? '');
        const score = homeScore && awayScore ? `${awayScore}-${homeScore}` : '-';

        const getByLabel = (label: string): string => {
          const idx = labels.indexOf(label);
          return idx >= 0 && idx < stats.length ? stats[idx] : '-';
        };

        let points: string;
        let rebounds: string;
        let assists: string;
        let minutes: string;
        let steals: string;
        let blocks: string;
        let turnovers: string;
        let fg: string;
        let threeP: string;
        let ft: string;
        let plusMinus: string;
        // MLB-only role + nested peripherals; both stay undefined on
        // non-MLB rows. Mirror of RN parser — keep field-population
        // logic identical so adapters grade the same in both paths.
        let mlbRole: 'batter' | 'pitcher' | null | undefined;
        let mlbExtras: PlayerGameLogMlbExtras | undefined;
        let nhlPosition: 'skater' | 'goalie' | null | undefined;

        if (isMLB) {
          if (isMLBPitcher) {
            points = getByLabel('SO') !== '-' ? getByLabel('SO') : getByLabel('K');
            rebounds = getByLabel('IP');
            assists = getByLabel('ER');
            minutes = getByLabel('IP');
            steals = getByLabel('BB');
            blocks = getByLabel('HR');
            turnovers = getByLabel('H');
            fg = getByLabel('ERA');
            threeP = getByLabel('WHIP');
            ft = getByLabel('W');
            plusMinus = getByLabel('L');
            mlbRole = 'pitcher';
            // Pitches Thrown from ESPN's "PC-ST" label ("{pitches}-{strikes}",
            // e.g. "95-62"). Same parse shape as 3PT made-attempts.
            const pcSt = getByLabel('PC-ST');
            const pcLhs = pcSt && pcSt !== '-' ? pcSt.split('-')[0] : undefined;
            mlbExtras = pcLhs ? { pitchesThrown: pcLhs } : {};
          } else {
            points = getByLabel('H');
            rebounds = getByLabel('HR');
            assists = getByLabel('RBI');
            minutes = getByLabel('AB');
            steals = getByLabel('SB');
            blocks = getByLabel('BB');
            turnovers = getByLabel('SO');
            fg = getByLabel('AVG');
            threeP = getByLabel('OBP');
            ft = getByLabel('SLG');
            plusMinus = getByLabel('OPS');
            mlbRole = 'batter';
            // Singles computed as H − 2B − 3B − HR (ESPN has no 1B label).
            // Each component undefined when its source is missing; adapters
            // null-check, so missing → null → manual-settle.
            const doublesRaw = getByLabel('2B');
            const triplesRaw = getByLabel('3B');
            const runsRaw = getByLabel('R');
            const h = parseFloat(points);
            const d = parseFloat(doublesRaw);
            const t = parseFloat(triplesRaw);
            const hr = parseFloat(rebounds);
            const singles =
              Number.isFinite(h) && Number.isFinite(d) && Number.isFinite(t) && Number.isFinite(hr)
                ? String(Math.max(0, h - d - t - hr))
                : undefined;
            mlbExtras = {
              ...(singles !== undefined ? { singles } : {}),
              ...(doublesRaw && doublesRaw !== '-' ? { doubles: doublesRaw } : {}),
              ...(triplesRaw && triplesRaw !== '-' ? { triples: triplesRaw } : {}),
              ...(runsRaw && runsRaw !== '-' ? { runs: runsRaw } : {}),
            };
          }
        } else if (isNFL) {
          // NFL: stats live in `categories` (passing/rushing/receiving)
          // populated below; flat fields stay '-'.
          points = '-';
          rebounds = '-';
          assists = '-';
          minutes = '-';
          steals = '-';
          blocks = '-';
          turnovers = '-';
          fg = '-';
          threeP = '-';
          ft = '-';
          plusMinus = '-';
        } else if (isNHL) {
          if (isNHLGoalie) {
            // NHL goalie remap. ESPN labels (verified live 2026-05):
            //   GS, TOI/G, WINS, L, T, OTL, GA, GAA, SA, SV, SV%, SO
            points = getByLabel('SV');
            rebounds = getByLabel('GA');
            assists = getByLabel('SA');
            minutes = getByLabel('TOI/G');
            steals = getByLabel('SV%');
            blocks = getByLabel('GAA');
            turnovers = getByLabel('SO');
            fg = getByLabel('WINS');
            threeP = getByLabel('L');
            ft = getByLabel('OTL');
            plusMinus = getByLabel('GS');
            nhlPosition = 'goalie';
          } else {
            // NHL skater remap. ESPN labels:
            //   G, A, PTS, +/-, PIM, S, SPCT, PPG, PPA, SHG, SHA, GWG,
            //   TOI/G, PROD
            //
            // 'S' is shots-on-goal (verified by ESPN's description on
            // the boxscore endpoint: "Total shots."). 'SOG' on the
            // boxscore is shootout goals — different stat — so adapters
            // read 'S' here, not 'SOG'.
            //
            // Hits / Blocked Shots are NOT in this endpoint. The
            // settlement watcher's SOURCE_OF_TRUTH map routes those
            // props through fetchGameBoxScore + boxScoreToGameLogShape
            // instead. Mirror of RN parser comment.
            points = getByLabel('G');
            rebounds = getByLabel('A');
            assists = getByLabel('PTS');
            minutes = getByLabel('TOI/G');
            steals = getByLabel('S');
            blocks = '-';
            turnovers = '-';
            fg = getByLabel('PPG');
            threeP = getByLabel('PPA');
            ft = getByLabel('SHG');
            plusMinus = getByLabel('+/-');
            nhlPosition = 'skater';
          }
        } else {
          // NBA / WNBA / NCAAM (basketball)
          points = getByLabel('PTS');
          rebounds = getByLabel('REB');
          assists = getByLabel('AST');
          minutes = getByLabel('MIN');
          steals = getByLabel('STL');
          blocks = getByLabel('BLK');
          turnovers = getByLabel('TO');
          fg = getByLabel('FG');
          threeP = getByLabel('3PT');
          ft = getByLabel('FT');
          plusMinus = getByLabel('+/-');
        }

        const nflCategories = isNFL && nflSections ? buildNflCategories(nflSections, labels, stats) : undefined;

        entries.push({
          date: gameDate,
          opponent: opponentName,
          homeAway: atVs === '@' ? 'A' : 'H',
          result: gameResult === 'W' ? 'W' : gameResult === 'L' ? 'L' : '-',
          score,
          minutes,
          points,
          rebounds,
          assists,
          steals,
          blocks,
          turnovers,
          fg,
          threeP,
          ft,
          plusMinus,
          ...(nflCategories ? { categories: nflCategories } : {}),
          ...(mlbRole !== undefined ? { mlbRole } : {}),
          ...(mlbExtras !== undefined ? { mlbExtras } : {}),
          ...(nhlPosition !== undefined ? { nhlPosition } : {}),
        });
      }
    }
  }

  entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return entries.slice(0, 20);
}
