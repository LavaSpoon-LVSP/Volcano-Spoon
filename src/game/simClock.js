/**
 * Injectable simulation clock — lets a replay control "now" instead of every
 * subsystem reading the wall clock directly. Same idea as seededRandom.js,
 * for time instead of randomness.
 *
 * Live gameplay is completely unaffected: now() returns real Date.now() by
 * default, exactly like every call site used to call Date.now() itself.
 *
 * A server-side replay instead points this at the RECORDED per-frame
 * timestamps from the original run (see the replay engine), so every timer
 * that reads now() — orb spawn intervals, combo timeout, powerup/hazard
 * expiry, session-elapsed calculations, anything gameplay-affecting — fires
 * at exactly the same simulated moments it did in the real run, regardless
 * of when the replay actually executes on the server.
 *
 * Concurrency note: same constraint as seededRandom.js — this is a
 * module-level singleton, so a replay must run synchronously start-to-
 * finish with no `await` inside its per-frame step loop. Node's single-
 * threaded event loop can't preempt a synchronous call, so as long as that
 * holds, two replays (or a replay and anything else touching this module)
 * can never interleave.
 */
let _now = () => Date.now()
let _active = false

/** Point the shared clock at a replay-controlled time source.
 *   - Pass a function: called every time now() is read (e.g. () => currentSimMs).
 *   - Pass a number: freezes the clock at exactly that instant (advance it
 *     yourself between steps by calling setSimClock again with a new value).
 *   - Pass null/undefined: restores the real wall clock (Date.now()).
 */
export function setSimClock(source) {
  if (source == null) {
    _now = () => Date.now()
    _active = false
    return
  }
  _now = typeof source === 'function' ? source : () => source
  _active = true
}

/** Drop-in replacement for Date.now() throughout gameplay-timing code. */
export function now() {
  return _now()
}

/** True while a non-default (replay-controlled) clock source is active —
 *  mirrors seededRandom.js's isSeeded(). */
export function isSimClockActive() {
  return _active
}
