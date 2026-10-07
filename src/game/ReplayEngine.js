import { GameLogic } from './GameLogic.js'
import { seedRandom } from './seededRandom.js'
import { setSimClock } from './simClock.js'

// A run this implausible in shape can't have come from the real client loop
// (see the size guard in ClientSession._handleRunReport, which checks these
// against the server's own measured elapsed time before ever calling
// replayRun) — these are just a hard backstop against a malformed/hostile
// payload wasting CPU here too.
const MAX_FRAMES = 500000
const MAX_INPUTS = 20000

/**
 * Replays one run from its recorded seed + input/frame log and returns the
 * server's own authoritative score/coins/jackpotTokensCollected for it.
 * This is what ClientSession._handleRunReport now trusts INSTEAD OF the
 * client's self-reported numbers — a forged game:run_report can no longer
 * hand-pick a payout, because the payout is derived here, not read off the
 * message.
 *
 * Runs the exact same GameLogic/OrbSystem/ArenaSystem/etc. simulation the
 * real client used, stepped through the same recorded per-frame dt values
 * and discrete inputs, with the shared seededRandom/simClock singletons
 * pinned to this run's own seed and a replay-controlled virtual clock (see
 * those modules' own doc comments) instead of live Math.random()/Date.now().
 *
 * MUST be called fully synchronously — no `await` anywhere in this
 * function or anything it calls — because seedRandom()/setSimClock() are
 * process-wide singletons. Node's single-threaded event loop can't preempt
 * a synchronous call, so as long as this stays synchronous start-to-finish,
 * two overlapping replays (or a replay racing a tutorial's live tick) can
 * never interleave and corrupt each other's RNG/clock state. If this ever
 * needs to become async (e.g. to yield for very long runs), the singletons
 * MUST be replaced with per-call instances first (see createSeededRng in
 * seededRandom.js).
 *
 * @param {object} run
 * @param {number} run.seed - this run's server-issued seed (see
 *   ClientSession._handleGameRestart) — NEVER taken from the client.
 * @param {number[]} run.frames - per-frame dt values in order, already
 *   normalized to "1 == one 60Hz frame" exactly like the value the real
 *   client passes to GameLogic.update(dt).
 * @param {Array<{atFrame:number, type:string, dx?:number, dy?:number}>} [run.inputs]
 *   - discrete inputs (launch/click/flap), each tagged with the 0-based
 *   frame index it must be applied immediately before, matching how the
 *   client captured them relative to its own frame count (see Game.jsx).
 * @param {number} [run.arenaStage] - arena stage this run was played
 *   under, so orb pacing/rewards match what the client actually ran with.
 * @param {{lavaCoinMultiplier?:number, rareOrbChance?:number}} [run.stageMultipliers]
 * @param {{healRegen?:boolean, pickupRadiusBonus?:boolean, comboDurationBonus?:boolean, hazardVisibility?:boolean, comboStabilize?:boolean}} [run.artifactPerks]
 *   - the player's server-derived NFT-artifact perk flags AT THE TIME this
 *   run started (see game/artifactPerks.js / ClientSession._activeRun),
 *   never re-derived live here — a run must always replay under the exact
 *   perks it was actually played with, even if the player's active
 *   artifacts change again before the report arrives.
 * @returns {{score:number, coins:number, jackpotTokensCollected:number, framesReplayed:number, crashed:boolean, error?:string}}
 */
export function replayRun({ seed, frames, inputs, arenaStage, stageMultipliers, artifactPerks }) {
  if (!Number.isFinite(seed) || !Array.isArray(frames)) {
    return { score: 0, coins: 0, jackpotTokensCollected: 0, framesReplayed: 0, crashed: true, error: 'invalid_replay_input' }
  }
  if (frames.length > MAX_FRAMES || (Array.isArray(inputs) && inputs.length > MAX_INPUTS)) {
    return { score: 0, coins: 0, jackpotTokensCollected: 0, framesReplayed: 0, crashed: true, error: 'replay_log_too_large' }
  }

  // Walk inputs in lockstep with the frame loop (both already/now sorted by
  // frame index) instead of re-scanning the whole inputs array every frame.
  const sortedInputs = Array.isArray(inputs)
    ? [...inputs].sort((a, b) => (Number(a?.atFrame) || 0) - (Number(b?.atFrame) || 0))
    : []
  let inputCursor = 0

  seedRandom(seed)
  let simNow = 0
  setSimClock(() => simNow)

  try {
    const game = new GameLogic()
    game.reset()
    if (arenaStage) {
      game.setArenaStage?.(arenaStage, stageMultipliers || {})
    }
    game.setArtifactPerks?.(artifactPerks || {})

    for (let i = 0; i < frames.length; i += 1) {
      while (inputCursor < sortedInputs.length && Number(sortedInputs[inputCursor]?.atFrame) <= i) {
        const input = sortedInputs[inputCursor]
        game.handleInput(input?.type || 'launch', { dx: Number(input?.dx) || 0, dy: Number(input?.dy) || 0 })
        inputCursor += 1
      }

      // Clamp exactly like the REAL client gameplay loop does (Game.jsx's
      // stepLocalGame: `Math.min(3, (nowMs - lastFrameMs) / (1000/60))`) so
      // a forged/corrupted per-frame dt can never fast-forward the
      // simulation further than a real device legitimately could in one
      // frame. (Not the same clamp as GameEngine.js's separate cosmetic
      // prediction-rendering loop, which uses 4 for a different purpose.)
      const rawDt = Number(frames[i])
      const dt = Number.isFinite(rawDt) && rawDt > 0 ? Math.min(3, rawDt) : 1

      game.update(dt)
      simNow += dt * 16.667

      if (game.gameOver) {
        return {
          score: game.score,
          coins: game.coins,
          jackpotTokensCollected: game.jackpotTokensCollected,
          framesReplayed: i + 1,
          crashed: false,
        }
      }
    }

    return {
      score: game.score,
      coins: game.coins,
      jackpotTokensCollected: game.jackpotTokensCollected,
      framesReplayed: frames.length,
      crashed: false,
    }
  } catch (error) {
    console.error('[ReplayEngine] replay crashed — treating as invalid run', error)
    return { score: 0, coins: 0, jackpotTokensCollected: 0, framesReplayed: 0, crashed: true, error: error.message }
  } finally {
    // Always release the singletons back to real time/randomness so
    // nothing else in this process (another session's live tick, the next
    // replay) is left pointed at this run's frozen seed/clock.
    setSimClock(null)
    seedRandom(NaN)
  }
}
