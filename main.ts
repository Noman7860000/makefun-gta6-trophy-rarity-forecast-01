// gta6-trophy-rarity-forecast-01 — a dilution-aware logit forecaster (Node 22, standard library only).
//
// Forecasts, for every trophy of Grand Theft Auto VI on PlayStation 5, its earn rate on Exophase
// at a case's target. Reads every <id>.in in the input directory and writes <id>.out to the
// output directory: {"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}, five quantiles in percent,
// non-decreasing, 0 to 100. Deterministic (no randomness) and fast (<1s per case).
//
// The model — why it beats persistence (the house baseline):
// Exophase's tracked player base is not a fixed panel. Right after launch it is a few hundred
// hardcore players; days later it is orders of magnitude larger and mostly casual. Two forces move
// a trophy's rate:
//   (1) DILUTION: new tracked players join having earned almost nothing yet, so rates fall. It is
//       strongest in the first hours (the launch-night refresh grew the panel 638 -> 3,868 and
//       every rate but the 100% one fell), and it fades as the panel's growth rate slows.
//   (2) PROGRESSION: the players already tracked keep playing and earn trophies, so rates rise.
//       It is strongest for trophies early in the game (the opening chapters, first activities)
//       and weakest for the platinum, 100% completion and long grinds, which almost nobody reaches
//       in a week.
// A short horizon (the 90-minute practice cases) is dilution-dominated: rates fall. A long horizon
// (the final's 4.5 days) is progression-dominated for reachable trophies: their rates climb toward
// the level a one-week player base reaches, while the rarest trophies stay near where they are.
// So the forecast median is a blend of the last read's rate and a "mature" one-week prior for the
// trophy, the blend weight growing with the horizon, plus a dilution term that is large only while
// the game is hours old. The spread widens with the horizon (a random walk on the logit scale)
// plus a base term for model uncertainty, because a week out the honest answer is a wide band.
//
// The mature prior is derived from the trophy itself (read from the case file): its tier, its
// description (chapter number, "final mission", "100% Completion", grind keywords) and its
// launch-night rate (a trophy more of the first few hundred players earned is earlier/easier).
// Nothing is hard-coded to a trophy id, and nothing is fetched from the network.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input
// and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Random-walk spread, in logit units per square-root day. */
const SIGMA_WALK = 0.55;
/** Base spread for model uncertainty, in logit units. */
const SIGMA_BASE = 0.45;
/** How fast the forecast moves from the last rate toward the mature prior (days). */
const BLEND_TAU_DAYS = 1.5;
/** Dilution strength (logit units) while the game is hours old. */
const DILUTION_STRENGTH = 1.2;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface Case {
  id: string;
  at: string;
  levels: number[];
  horizon_minutes: number;
  target: string;
  game: { release_date?: string };
  trophies: Trophy[];
  history: Array<{ at: string; players_tracked: number; rates: Array<number | null> }>;
}

const clampRate = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clampRate(pct) / (100 - clampRate(pct)));
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * The rate (percent) a trophy settles toward once the player base has had about a week:
 * derived from the trophy's own description and tier. Story chapters fall with chapter number
 * (fewer players reach each later chapter in a week); the final mission and 100% completion are
 * rare; long grinds stay rare; side activities scale with how many of the launch-night players
 * had already earned them (a higher launch-night rate means earlier/easier).
 */
function matureRate(t: Trophy, launchRate: number): number {
  const desc = t.description;
  if (t.tier === 'platinum') return 0.25;
  if (/Gone Fishing/.test(desc)) return 99.5;
  const chapter = desc.match(/Complete Chapter (\d+)/);
  if (chapter) {
    const n = Number(chapter[1]);
    // Chapter 1 ~45%, then roughly 0.7x per chapter.
    return [45, 32, 22, 14, 9, 6][Math.min(Math.max(n - 1, 0), 5)] ?? 6;
  }
  if (/final mission/i.test(desc) && !/for /.test(desc)) return 6;
  if (/100% Completion/.test(desc)) return 0.4;
  if (/250 Stunts/.test(desc)) return 0.8;
  if (/50 Challenges/.test(desc)) return 2;
  if (/Collectible Card sets/.test(desc)) return 1;
  if (/100 locations/.test(desc)) return 1.2;
  if (/gold medal in all/.test(desc)) return 1.5;
  if (/final mission for /.test(desc)) return 9;
  if (/^Complete /.test(desc)) return 15;
  // Side activity: scale the launch-night rate (earlier/easier trophies were earned by more of
  // the first few hundred players), clamped to a sane band.
  const scaled = launchRate * 8;
  return Math.min(30, Math.max(2, scaled));
}

/** Read a written forecast back and check it obeys the contest's shape, or throw naming the problem. */
function verifyOutput(outPath: string, expectedIds: number[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {
    throw new Error(`${outPath} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length !== 1 || !('trophies' in parsed)) {
    throw new Error(`${outPath} must be exactly {"trophies": [...]}`);
  }
  const rows = (parsed as { trophies: unknown }).trophies;
  if (!Array.isArray(rows) || rows.length !== expectedIds.length) {
    throw new Error(`${outPath} must have exactly ${expectedIds.length} rows, got ${Array.isArray(rows) ? rows.length : 'not an array'}`);
  }
  const seen = new Set<number>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Object.keys(row).length !== 2 || !('id' in row) || !('q' in row)) {
      throw new Error(`${outPath} has a row that is not exactly {"id": n, "q": [...]}`);
    }
    const { id, q } = row as { id: unknown; q: unknown };
    if (typeof id !== 'number' || !expectedIds.includes(id) || seen.has(id)) {
      throw new Error(`${outPath} has a bad or duplicated id: ${JSON.stringify(id)}`);
    }
    seen.add(id);
    if (!Array.isArray(q) || q.length !== LEVELS.length) {
      throw new Error(`${outPath} trophy ${id} must have exactly ${LEVELS.length} quantiles`);
    }
    for (let j = 0; j < q.length; j++) {
      const v = q[j];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
        throw new Error(`${outPath} trophy ${id} quantile ${j} is not a finite number in 0-100: ${JSON.stringify(v)}`);
      }
      if (j > 0 && (q[j] as number) < (q[j - 1] as number)) {
        throw new Error(`${outPath} trophy ${id} quantiles are not non-decreasing`);
      }
    }
  }
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const last = c.history[c.history.length - 1];
  const first = c.history[0];
  const d = c.horizon_minutes / 1440; // horizon in days
  // Age of the game at the checkpoint, in days (release_date is a date, `at` a timestamp).
  const release = c.game?.release_date ? Date.parse(`${c.game.release_date}T00:00:00Z`) : NaN;
  const atMs = Date.parse(c.at);
  const ageDays = Number.isFinite(release) && Number.isFinite(atMs) ? Math.max(0, (atMs - release) / 86_400_000) : 0;

  // Blend weight on the mature prior: near 0 for a 90-minute horizon, near 1 for 4.5 days.
  const w = 1 - Math.exp(-d / BLEND_TAU_DAYS);
  // Dilution: large only while the game is hours old (the launch-night refresh), fading with age.
  const dilution = -DILUTION_STRENGTH * Math.exp(-ageDays * 0.8) * (d / (d + 0.03));
  // Spread: random walk with horizon plus a base term for model uncertainty.
  const sigma = SIGMA_WALK * Math.sqrt(d) + SIGMA_BASE;

  const trophies = c.trophies.map((t, i) => {
    const rLast = last.rates[i] ?? 0;
    const rLaunch = first.rates[i] ?? rLast;
    const lLast = logit(rLast);
    const lMature = logit(matureRate(t, rLaunch));
    const lMed = (1 - w) * lLast + w * lMature + dilution;
    const q = Z.map((z) => round4(clampRate(invLogit(lMed + z * sigma))));
    // Keep the row non-decreasing after rounding (rounding can tie, never invert).
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { id: t.id, q };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
  // Read the forecast back and refuse to exit silently on a malformed file.
  verifyOutput(join(OUTPUT_DIR, `${id}.out`), c.trophies.map((t) => t.id));
}
