/**
 * Deterministic seeded PRNG (mulberry32) used for every piece of GAMEPLAY-
 * AFFECTING randomness — orb type/rarity rolls, coin-payout rolls, hazard/
 * obstacle picks — instead of raw Math.random(). This is what makes a run
 * replayable: given the same seed and the same recorded inputs, this
 * produces the exact same sequence of "random" decisions every time, on
 * both the client (real-time) and the server (replay).
 *
 * Only gameplay-affecting randomness needs to run through this. Purely
 * cosmetic randomness (screen-shake jitter, particle drift/size/lifetime)
 * does NOT need to be seeded — it never feeds back into score/coins/
 * jackpot tokens, so it can keep using Math.random() directly and stay
 * out of the replay log entirely. See the audit notes in
 * GameLogic.js / OrbSystem.js / ArenaSystem.js for which calls were moved
 * to random() below and which were deliberately left as Math.random().
 *
 * mulberry32 is pure 32-bit integer arithmetic (Math.imul + bitwise ops),
 * so it produces bit-identical output across engines/runtimes (browser V8
 * and Node's V8 alike) — no floating-point rounding differences to worry
 * about between where a run is played and where it's replayed.
 *
 * Concurrency note: `seedRandom`/`random` below is a module-level
 * singleton, which is safe as long as only one seeded sequence is ever
 * being consumed at a time per process:
 *   - Frontend: fine as-is — one browser tab runs exactly one game.
 *   - Backend (replay engine): a replay MUST run start-to-finish as one
 *     synchronous call with no `await` inside its step loop. Node's
 *     single-threaded event loop can't preempt a synchronous call, so two
 *     replays (or a replay and something else touching this module) can
 *     never interleave as long as that holds. If the replay loop is ever
 *     changed to yield mid-run (an `await` inside the per-frame step),
 *     this singleton is no longer safe and callers must switch to holding
 *     their own `createSeededRng(seed)` instance instead of the shared
 *     `random()` export.
 */

/** Create a standalone seeded RNG instance — a function returning floats
 *  in [0, 1), just like Math.random(). Use this directly (instead of the
 *  singleton below) anywhere multiple independent seeded sequences might
 *  need to be live at once. */
export function createSeededRng(seed) {
  let a = seed >>> 0
  return function mulberry32() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Falls back to real Math.random() until seedRandom() is called, so any
// gameplay-random call made before a run has a seed (there shouldn't be
// any — see the seeding-timing note this ships alongside) fails safe
// instead of throwing.
let _rng = Math.random

/** Reseed the shared gameplay RNG. Call this once, before a run's first
 *  gameplay-affecting random call:
 *   - Client: as soon as the server's seed for this run is known (see
 *     'run:token' handling in Game.jsx) — and NOT before, since a fresh
 *     seed must never be reused across runs.
 *   - Server replay: immediately before replaying a specific run, seeded
 *     with that exact run's stored seed.
 *  Passing a non-finite value resets to real Math.random() (used when a
 *  seed genuinely isn't available yet — see the deferred-spawn-clock
 *  design note — rather than silently reusing whatever seed came before). */
export function seedRandom(seed) {
  _rng = Number.isFinite(seed) ? createSeededRng(seed) : Math.random
}

/** Drop-in replacement for Math.random() for gameplay-affecting code —
 *  returns a float in [0, 1) drawn from the currently-seeded sequence. */
export function random() {
  return _rng()
}

/** True once a real seed (not the Math.random() fallback) is active. Lets
 *  spawn-timer code defer its first random-consuming decision until a
 *  seed has actually arrived, instead of silently drawing from
 *  unseeded/unreplayable Math.random(). */
export function isSeeded() {
  return _rng !== Math.random
}
