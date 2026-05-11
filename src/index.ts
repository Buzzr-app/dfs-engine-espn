/**
 * @buzzr/dfs-engine-espn — ESPN data adapter for @buzzr/dfs-engine.
 *
 * Fetches gamelogs, boxscores, and injury reports from ESPN's public
 * (undocumented) site API and shapes them into the data structures
 * that dfs-engine adapters consume.
 *
 * No auth, no API key. Caller is responsible for respecting reasonable
 * request volume — ESPN doesn't publish a rate limit, but ~1 req/sec
 * per endpoint is the empirical safe ceiling.
 *
 * Use at your own risk. ESPN endpoints are undocumented; if a shape
 * changes, this package can fall behind. PRs welcome.
 */

// Boxscore — per-game stats for in-progress and final games.
export {
  fetchGameBoxScore,
  parseBoxScore,
  type BoxScore,
  type BoxScoreState,
  type FetchBoxScoreOptions,
} from './boxscore';

// Gamelog — season-level per-game history.
export {
  fetchPlayerGamelog,
  buildNflLabelSections,
  type PlayerGameLogEntry,
  type PlayerGameLogCategories,
  type PlayerGameLogMlbExtras,
} from './gamelog';

// Injury status — pre-game DNP detection.
export {
  fetchInjuryStatus,
  isAutoDnpStatus,
  type InjuryStatus,
} from './injuries';

// Shape converter — gamelog entry → PlayerGameLogEntryShape (from dfs-engine).
export { gamelogEntryToShape } from './converter';

// Endpoint constants (override URLs / sport paths for custom builds).
export { ESPN_BASE_URL, ESPN_SPORT_PATHS, DEFAULT_FETCH_TIMEOUT_MS } from './constants';
