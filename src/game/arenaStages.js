/**
 * ARENA STAGES — per-stage hazard/pace configuration (frontend)
 *
 * Ported from the backend's src/game/arenaStages.js — this is what "specific
 * arenas have specific hazards/orbs" actually means in this codebase, and it
 * was never wired into the frontend engine at all (which used to just run
 * every hazard, at the same pace, on every arena). This file is the single
 * source of truth ArenaSystem.js and GameLogic.js read from.
 *
 *   Stage 1 — Basic movement. No darkness, no earthquake. Gentlest hazards,
 *             slowest pace (0.35x). Spikes/knives present but sparse.
 *   Stage 2 — Still calm, noticeably quicker than Stage 1.
 *   Stage 3 — Fire Wall orbs / lava sticks ramp up (fireWallBoost).
 *   Stage 4 — More frequent hazards across the board.
 *   Stage 5 — EARTHQUAKE unlocks here, plus multiple overlapping hazards.
 *   Stage 6 — DARKNESS unlocks here, combined with everything from 5.
 *   Stage 7 — Everything, harder.
 *   Stage 8 — Everything, hardest, fastest pace (1.40x).
 *
 * `earthquake` and `darkness` are hard-gated: no stage below
 * EARTHQUAKE_MIN_STAGE / DARKNESS_MIN_STAGE may ever trigger them, from any
 * path (random rotation or boss phase) — see ArenaSystem's _triggerWorldEvent.
 */

export const ARENA_STAGE_COUNT = 8
export const MIN_ARENA_STAGE = 1
export const MAX_ARENA_STAGE = ARENA_STAGE_COUNT

export const EARTHQUAKE_MIN_STAGE = 5
export const DARKNESS_MIN_STAGE   = 6

// World events that are always available, from Stage 1 onward (everything
// except earthquake/darkness, which are hard-gated above).
export const BASE_WORLD_EVENTS = [
  'lava_rain', 'wind_zone', 'lava_walls', 'orb_storm', 'eruption_burst',
]

// Stage 1 is intentionally very slow; each later stage ramps the overall
// pace up by a flat step. Drives orb speed and orb spawn rate (the
// player's own swipe/launch response is deliberately NOT scaled by this
// any more — see GameLogic.js's pacing block — so a swipe feels the same
// everywhere; this multiplier is purely how fast the arena itself moves).
// Was 0.60x-1.44x, then widened to 0.45x-1.50x to survive GameLogic.js's
// within-run ramp swallowing the gap between stages. Base lowered again
// (0.45 → 0.35) so the early stages in particular read as clearly slower —
// they were still felt as "too fast to start on".
const STAGE_PACE_BASE = 0.35
const STAGE_PACE_STEP = 0.15
export function stagePaceMultiplier(stage) {
  return STAGE_PACE_BASE + (clampStage(stage) - 1) * STAGE_PACE_STEP
}
// Stage 1: 0.35x · 2: 0.50x · 3: 0.65x · 4: 0.80x · 5: 0.95x · 6: 1.10x ·
// 7: 1.25x · 8: 1.40x

/** How OFTEN the big world events (lava rain, wind, walls, orb storm,
 * eruption, earthquake, darkness) fire. >1 = more frequent. */
const STAGE_HAZARD_FREQUENCY = {
  1: 0.70, 2: 0.85, 3: 1.00, 4: 1.35, 5: 1.60, 6: 1.85, 7: 2.10, 8: 2.40,
}

/** Wall spikes / ninja knives — kept on a separate, gentler-at-the-bottom
 * curve from the big world events so Stage 1 still has SOMETHING to react
 * to (learn the hazards) without being hit by darkness/earthquake. */
const STAGE_LIGHT_HAZARD_FREQUENCY = {
  1: 0.55, 2: 0.80, 3: 1.10, 4: 1.50, 5: 1.75, 6: 2.00, 7: 2.20, 8: 2.50,
}

/** How many spikes/knives each burst contains — separate from frequency so
 * Stage 1 gets both fewer bursts AND smaller ones. */
const STAGE_LIGHT_HAZARD_COUNT = {
  1: 0.50, 2: 0.75, 3: 1.00, 4: 1.10, 5: 1.20, 6: 1.30, 7: 1.45, 8: 1.60,
}

/** Fire Wall orb / lava-stick pressure. Stage 3 is the explicit "fireball
 * hazards increase" step. */
const STAGE_FIRE_WALL_BOOST = {
  1: 1.0, 2: 1.0, 3: 2.0, 4: 2.0, 5: 2.2, 6: 2.4, 7: 2.6, 8: 3.0,
}

/** Upward launch impulse — Stage 2 is the explicit "faster upward roll" step. */
const STAGE_LAUNCH_IMPULSE = {
  1: 1.0, 2: 1.25, 3: 1.25, 4: 1.30, 5: 1.30, 6: 1.35, 7: 1.35, 8: 1.40,
}

/** How many hazards may run at once. Stage 5's "multiple hazards" and
 * Stage 6's "combined hazards" are this going above 1. */
const STAGE_CONCURRENT_HAZARDS = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 3,
}

function clampStage(stage) {
  const n = Number(stage)
  if (!Number.isFinite(n)) return MIN_ARENA_STAGE
  return Math.min(MAX_ARENA_STAGE, Math.max(MIN_ARENA_STAGE, Math.round(n)))
}

/** Returns the full per-stage profile ArenaSystem/GameLogic apply. */
export function getStageProfile(stage) {
  const s = clampStage(stage)
  const allowedWorldEvents = [...BASE_WORLD_EVENTS]
  if (s >= EARTHQUAKE_MIN_STAGE) allowedWorldEvents.push('earthquake')
  if (s >= DARKNESS_MIN_STAGE)   allowedWorldEvents.push('darkness')

  return {
    stage: s,
    pace: stagePaceMultiplier(s),
    allowedWorldEvents,
    allowEarthquake: s >= EARTHQUAKE_MIN_STAGE,
    allowDarkness:   s >= DARKNESS_MIN_STAGE,
    hazardFrequencyMultiplier:      STAGE_HAZARD_FREQUENCY[s] ?? 1,
    lightHazardFrequencyMultiplier: STAGE_LIGHT_HAZARD_FREQUENCY[s] ?? 1,
    lightHazardCountMultiplier:     STAGE_LIGHT_HAZARD_COUNT[s] ?? 1,
    fireWallBoost:                  STAGE_FIRE_WALL_BOOST[s] ?? 1,
    launchImpulseMultiplier:        STAGE_LAUNCH_IMPULSE[s] ?? 1,
    maxConcurrentHazards:           STAGE_CONCURRENT_HAZARDS[s] ?? 1,
  }
}

// ============================================================================
// BACKEND COMPATIBILITY LAYER — for routes/arenaStages.js only
// ============================================================================
// routes/arenaStages.js (the Arena Stages progression/economy API) needs a
// per-stage METADATA list -- stage number, display name, and which
// powerup-style orbs it's unlocked -- for the Arena Select screen and the
// admin config panel. That's a different concern from getStageProfile()
// above (which feeds live hazard/pace tuning into ArenaSystem/GameLogic),
// so it's kept separate here rather than folding fields onto that object,
// where they'd have no meaning to the actual physics/hazard code that
// reads it.
//
// This is intentionally NOT the full ARENA_STAGE_CONFIGS this codebase had
// before the client-side migration (movementSpeedMultiplier,
// enemySpeedMultiplier, spawnRateMultiplier, etc.) — those fields are
// superseded by getStageProfile()'s pace/hazard tuning above and are no
// longer read by anything; duplicating them here would just be a second,
// driftable copy of the same tuning. Confirmed by auditing every actual
// field access on ARENA_STAGE_CONFIGS across the whole backend: only
// `.stage`, `.name`, and `.availablePowerups` are ever read (both in
// routes/arenaStages.js).
import {
  SHIELD_MIN_ARENA_STAGE, COMBO_MIN_ARENA_STAGE, MAGNET_MIN_ARENA_STAGE,
  ROSE_MIN_ARENA_STAGE, HEALTH_MIN_ARENA_STAGE, FREEZE_MIN_ARENA_STAGE,
  GRAVITY_MIN_ARENA_STAGE,
} from './constants.js'

// Every powerup-style orb currently in the game, in unlock order — kept in
// sync with OrbSystem's own POWERUP_STAGE_GATES via these same
// *_MIN_ARENA_STAGE constants, so this list and what can actually spawn
// can never drift apart.
const ALL_POWERUP_TYPES = ['shield', 'combo', 'magnet', 'rose', 'health', 'freeze', 'gravity']

const POWERUP_MIN_STAGE = {
  shield: SHIELD_MIN_ARENA_STAGE,
  combo: COMBO_MIN_ARENA_STAGE,
  magnet: MAGNET_MIN_ARENA_STAGE,
  rose: ROSE_MIN_ARENA_STAGE,
  health: HEALTH_MIN_ARENA_STAGE,
  freeze: FREEZE_MIN_ARENA_STAGE,
  gravity: GRAVITY_MIN_ARENA_STAGE,
}

function stagePowerupRoster(stage) {
  return ALL_POWERUP_TYPES.filter((type) => stage >= POWERUP_MIN_STAGE[type])
}

/** Per-stage metadata for the Arena Stages API — see the block comment
 *  above for why this is deliberately minimal. */
export const ARENA_STAGE_CONFIGS = Object.freeze(
  Array.from({ length: ARENA_STAGE_COUNT }, (_, i) => {
    const stage = i + 1
    return Object.freeze({
      stage,
      name: `Arena Stage ${stage}`,
      availablePowerups: stagePowerupRoster(stage),
    })
  })
)

export function isValidArenaStage(stage) {
  const n = Number(stage)
  return Number.isInteger(n) && n >= MIN_ARENA_STAGE && n <= MAX_ARENA_STAGE
}

export default getStageProfile
