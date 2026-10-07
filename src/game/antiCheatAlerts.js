import { AntiCheatAlert } from '../models/AntiCheatAlert.js'

/**
 * One call site for "this looked like an attack, make sure someone can see
 * it later" — used by both the run-report validation path and the restart
 * rate limiter (see ClientSession.js). Persists to Mongo (see
 * AntiCheatAlert.js) AND still logs to console (console.warn/error calls
 * elsewhere in this file are intentionally left in place for local dev/
 * live-tail visibility) — this used to be console-only, which meant the
 * only record of an attack was whatever happened to still be in a rotated
 * log file. Never throws/awaited by callers — a failure to persist a
 * monitoring signal must never affect the run-report/restart response
 * itself.
 *
 * @param {{userId: string, ip?: string|null, type: string, detail?: object}} event
 */
export function recordAntiCheatAlert({ userId, ip = null, type, detail = null }) {
  AntiCheatAlert.create({ userId, ip, type, detail }).catch((err) => {
    console.error('[antiCheatAlerts] failed to persist alert (event still happened, see above):', err?.message)
  })
}
