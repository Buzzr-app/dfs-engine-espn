/**
 * Bridge a `PlayerGameLogEntry` from this package's gamelog fetcher into
 * the `PlayerGameLogEntryShape` that `@buzzr/dfs-engine` adapters consume.
 *
 * The two shapes differ in:
 *   - gamelog ships `opponent`, `homeAway`, `result`, `score` — not used
 *     by dfs-engine adapters, dropped here.
 *   - field names + sport-specific extras (mlbRole, mlbExtras, nhlPosition)
 *     are passed through unchanged.
 */
import type { PlayerGameLogEntryShape } from '@buzzr/dfs-engine';
import type { PlayerGameLogEntry } from './gamelog';

export function gamelogEntryToShape(entry: PlayerGameLogEntry): PlayerGameLogEntryShape {
  return {
    date: entry.date,
    minutes: entry.minutes,
    points: entry.points,
    rebounds: entry.rebounds,
    assists: entry.assists,
    steals: entry.steals,
    blocks: entry.blocks,
    turnovers: entry.turnovers,
    threeP: entry.threeP,
    fg: entry.fg,
    ft: entry.ft,
    plusMinus: entry.plusMinus,
    ...(entry.categories ? { categories: entry.categories } : {}),
    ...(entry.mlbRole !== undefined ? { mlbRole: entry.mlbRole } : {}),
    ...(entry.mlbExtras ? { mlbExtras: entry.mlbExtras } : {}),
    ...(entry.nhlPosition !== undefined ? { nhlPosition: entry.nhlPosition } : {}),
  };
}
