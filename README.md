# @buzzr/dfs-engine-espn

ESPN data adapter for [@buzzr/dfs-engine](https://www.npmjs.com/package/@buzzr/dfs-engine). Fetches gamelogs, boxscores, and injury reports from ESPN's public site API and shapes them into the data structures `dfs-engine` adapters consume.

```bash
npm install @buzzr/dfs-engine @buzzr/dfs-engine-espn
```

## Why a companion package

`@buzzr/dfs-engine` is pure grading + payout math. It accepts a `PlayerGameLogEntryShape` and returns the value to grade against the line. **You're responsible for the data.**

This package is the "give me data" half: fetch from ESPN, convert to the right shape, hand it to dfs-engine. Use it together or substitute your own data source.

## Quickstart

```ts
import { fetchPlayerGamelog, gamelogEntryToShape } from '@buzzr/dfs-engine-espn';
import { extractStatForProp, matchGameLogEntry } from '@buzzr/dfs-engine';

// Fetch a player's recent gamelog.
const entries = await fetchPlayerGamelog('3917376', 'NBA'); // Jayson Tatum

// Pick the entry matching the bet date.
const matched = matchGameLogEntry('2026-05-04T20:00:00Z', entries);
if (!matched) return null;

// Convert to dfs-engine's shape and grade.
const shape = gamelogEntryToShape(matched);
const points = extractStatForProp('Points', 'NBA', shape, 'prizepicks');
// → 28
```

## What's in here

| Module | Function |
|---|---|
| `boxscore` | `fetchGameBoxScore(league, eventId)` — per-game stats for live + final games. Returns `BoxScore` with home/away `BoxScoreTeam` blocks. NBA/WNBA/NCAAM/W/NHL coverage. |
| `gamelog` | `fetchPlayerGamelog(athleteId, league)` — season-level per-game history. NBA/WNBA/NCAAM/W/NFL/MLB/NHL coverage. |
| `injuries` | `fetchInjuryStatus(athleteId, league)` — current injury status. `isAutoDnpStatus` predicate for "this leg should auto-DNP." |
| `converter` | `gamelogEntryToShape(entry)` — convert this package's `PlayerGameLogEntry` to dfs-engine's `PlayerGameLogEntryShape`. |

## Custom fetch / timeouts

Every public fetcher accepts an options bag for `fetch` (override for caching, proxying, or testing) and `timeoutMs`:

```ts
await fetchGameBoxScore('NBA', 'event-123', {
  fetch: myCachedFetch,
  timeoutMs: 5000,
});
```

## Status & limitations

- **NFL / MLB on `fetchGameBoxScore`:** not yet flattened — ESPN's boxscore ships multi-category data (passing / rushing for NFL, batting / pitching for MLB) that this parser doesn't yet collapse correctly. Use `fetchPlayerGamelog` for those leagues meanwhile.
- **Soccer on gamelog:** not yet implemented; soccer slips currently need a different data source.
- **ESPN ToS:** Endpoints are public but undocumented. Respect reasonable request volume (~1 req/sec per endpoint empirically safe). Use at your own risk.
- **Coverage drift:** If ESPN changes a response shape, the parser may silently return null. File an issue with a captured response.

## License

MIT © Sarvesh Chidambaram
