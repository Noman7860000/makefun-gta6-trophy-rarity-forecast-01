[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Noman7860000/makefun-gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Noman7860000/makefun-gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

# GTA VI Trophy Rarity Forecaster

A forecaster for [the GTA 6 trophy rarity bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01) on make.fun: for each of the 55 PlayStation 5 trophies of Grand Theft Auto VI, it forecasts the earn rate on Exophase at a case's target time, as five quantiles (5%, 25%, 50%, 75%, 95%).

## How it works

`main.ts` (Node 22, standard library only, no network) reads every `<id>.in` case in the input directory and writes `<id>.out` — `{"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}`. It is deterministic: two runs write identical bytes.

The model is a dilution-aware logit forecaster. Exophase's tracked player base is not a fixed panel — right after launch it is a few hundred hardcore players, and days later it is orders of magnitude larger and mostly casual. Two forces move a trophy's rate:

- **Dilution** — new tracked players join having earned almost nothing yet, so rates fall. Strongest in the first hours (the launch-night refresh grew the panel 638 → 3,868 and every rate but the 100% one fell), fading as the panel's growth slows.
- **Progression** — the players already tracked keep playing and earn trophies, so rates rise. Strongest for trophies early in the game (the opening chapters, first activities) and weakest for the platinum, 100% completion and long grinds, which almost nobody reaches in a week.

A short horizon (the 90-minute practice cases) is dilution-dominated: rates fall. A long horizon (the final's 4.5 days) is progression-dominated for reachable trophies: their rates climb toward the level a one-week player base reaches. So the forecast median blends the last read's rate with a "mature" one-week prior for the trophy — derived from the trophy itself (tier, description, launch-night rate) — with the blend weight growing with the horizon, plus a dilution term that is large only while the game is hours old. The spread widens with the horizon (a random walk on the logit scale) plus a base term for model uncertainty.

## Run it

```bash
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

The practice cases (`input/p00.in`, `input/p01.in`) are in this repo for local testing; the grader supplies its own case file at `/input` and reads the forecast from `/output`.

## Files

- `main.ts` — the forecaster (Node 22, standard library only)
- `input/` — practice cases, for local testing only (not part of the entry)

---

Built by [web3nouman](https://make.fun/u/web3nouman) — [referral link](https://make.fun/r/9y40b2n3)
