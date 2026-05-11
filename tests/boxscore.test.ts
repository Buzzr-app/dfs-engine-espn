/**
 * Parse tests for ESPN boxscore responses. No network — uses a captured
 * minimal fixture so the test suite is hermetic.
 */
import { parseBoxScore, fetchGameBoxScore } from '../src/boxscore';
import nbaFixture from './fixtures/nba-boxscore-minimal.json';

describe('parseBoxScore — NBA fixture', () => {
  const result = parseBoxScore(nbaFixture, 'NBA');

  test('parses to non-null', () => {
    expect(result).not.toBeNull();
  });

  test('extracts state, period, displayClock', () => {
    expect(result?.state).toBe('in');
    expect(result?.period).toBe(3);
    expect(result?.displayClock).toBe('5:23');
  });

  test('matches home/away by team id (not block index)', () => {
    // Fixture ships [away, home] in boxscore.players but header says home=13, away=2.
    expect(result?.homeTeam.teamId).toBe('13');
    expect(result?.awayTeam.teamId).toBe('2');
  });

  test('extracts all athletes with stats labeled correctly', () => {
    const tatum = result?.awayTeam.players.find((p) => p.athleteId === '3917376');
    expect(tatum).toBeDefined();
    expect(tatum?.name).toBe('Jayson Tatum');
    expect(tatum?.stats.PTS).toBe('28');
    expect(tatum?.stats.REB).toBe('5');
    expect(tatum?.stats['3PT']).toBe('4-9');
  });

  test('home team players parse separately from away team', () => {
    expect(result?.homeTeam.players).toHaveLength(1);
    expect(result?.homeTeam.players[0]?.name).toBe('Joel Embiid');
    expect(result?.homeTeam.players[0]?.stats.REB).toBe('11');
  });
});

describe('parseBoxScore — defensive null returns', () => {
  test('non-object data returns null', () => {
    expect(parseBoxScore(null, 'NBA')).toBeNull();
    expect(parseBoxScore('not an object', 'NBA')).toBeNull();
    expect(parseBoxScore(42, 'NBA')).toBeNull();
  });

  test('missing boxscore.players returns null', () => {
    expect(parseBoxScore({ header: {} }, 'NBA')).toBeNull();
  });

  test('boxscore.players with <2 teams returns null', () => {
    expect(parseBoxScore({ boxscore: { players: [{}] } }, 'NBA')).toBeNull();
  });

  test('missing status defaults to pre / null period / null clock', () => {
    const result = parseBoxScore(
      {
        boxscore: { players: [{ team: { id: 'a' } }, { team: { id: 'b' } }] },
      },
      'NBA',
    );
    expect(result?.state).toBe('pre');
    expect(result?.period).toBeNull();
    expect(result?.displayClock).toBeNull();
  });
});

describe('fetchGameBoxScore — request shape', () => {
  test('returns null for unsupported league', async () => {
    const result = await fetchGameBoxScore('CRICKET', '12345', {
      fetch: () => Promise.reject(new Error('should not be called')),
    });
    expect(result).toBeNull();
  });

  test('returns null for empty event id', async () => {
    const result = await fetchGameBoxScore('NBA', '');
    expect(result).toBeNull();
  });

  test('respects opts.fetch override', async () => {
    let calledUrl = '';
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      calledUrl = typeof input === 'string' ? input : (input as Request).url;
      return new Response(JSON.stringify(nbaFixture), { status: 200 });
    };
    const result = await fetchGameBoxScore('NBA', 'event-xyz', { fetch: fakeFetch });
    expect(result).not.toBeNull();
    expect(calledUrl).toContain('basketball/nba');
    expect(calledUrl).toContain('summary?event=event-xyz');
  });

  test('returns null on non-2xx response', async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response('not found', { status: 404 });
    const result = await fetchGameBoxScore('NBA', 'event-xyz', { fetch: fakeFetch });
    expect(result).toBeNull();
  });

  test('returns null on malformed JSON', async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response('not json', { status: 200 });
    const result = await fetchGameBoxScore('NBA', 'event-xyz', { fetch: fakeFetch });
    expect(result).toBeNull();
  });
});
