/**
 * In-memory sliding-window rate limiter for 'game:restart' issuance (see
 * ClientSession._handleGameRestart). Deliberately NOT backed by the DB —
 * this only needs to survive within one server process's uptime; a restart
 * of the process resetting everyone's window is an acceptable cost for
 * avoiding a DB round trip on every single restart attempt (the whole
 * point is to reject spam CHEAPLY, before the Energy gate's DB call).
 *
 * If this backend is ever run as more than one process/instance behind a
 * load balancer, each instance enforces its own window independently —
 * fine as a defense-in-depth layer (still catches any one instance being
 * hammered), but not a substitute for a shared store (e.g. Redis) if
 * cross-instance precision ever matters. Flagged here rather than solved,
 * since this codebase runs as a single Node process today.
 */

// key -> number[] (ms timestamps of ALLOWED attempts only — a rejected
// attempt doesn't itself consume a slot, so retrying immediately after a
// rejection doesn't dig the hole deeper than the real attempts already did).
const _windows = new Map()

// Coarse periodic sweep so a long-lived process doesn't accumulate one
// array per user/IP forever after they stop playing. Not precise (doesn't
// need to be) — just bounds memory.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
let _lastSweep = Date.now()
function _maybeSweep(now, maxAgeMs) {
  if (now - _lastSweep < SWEEP_INTERVAL_MS) return
  _lastSweep = now
  for (const [key, arr] of _windows) {
    while (arr.length && now - arr[0] > maxAgeMs) arr.shift()
    if (arr.length === 0) _windows.delete(key)
  }
}

/**
 * @param {string} key - e.g. `user:<id>` or `ip:<ip>` or `user-unlimited:<id>`
 *   (a separate, tighter-tuned key namespace for the same user while
 *   Unlimited Energy is active — see ClientSession.js).
 * @param {{minGapMs:number, windowMs:number, maxInWindow:number}} opts
 * @returns {{allowed:boolean, reason?:'too_soon'|'too_many', retryAfterMs:number}}
 */
export function checkRestartRateLimit(key, { minGapMs, windowMs, maxInWindow }) {
  const now = Date.now()
  _maybeSweep(now, windowMs)

  let arr = _windows.get(key)
  if (!arr) {
    arr = []
    _windows.set(key, arr)
  }
  while (arr.length && now - arr[0] > windowMs) arr.shift()

  const lastTs = arr.length ? arr[arr.length - 1] : null
  if (lastTs != null && now - lastTs < minGapMs) {
    return { allowed: false, reason: 'too_soon', retryAfterMs: minGapMs - (now - lastTs) }
  }
  if (arr.length >= maxInWindow) {
    return { allowed: false, reason: 'too_many', retryAfterMs: Math.max(0, windowMs - (now - arr[0])) }
  }

  arr.push(now)
  return { allowed: true, retryAfterMs: 0 }
}

/** Test-only: drops all tracked windows. */
export function _resetAllRateLimits() {
  _windows.clear()
}
