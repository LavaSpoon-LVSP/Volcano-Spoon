import {
  LAUNCH_MAGNITUDE_REJECT_PX, MIN_HUMAN_INPUT_INTERVAL_MS,
  SCRIPTED_TIMING_MIN_SAMPLE, SCRIPTED_TIMING_MAX_STDDEV_MS,
} from './constants.js'

/**
 * BASIC ANTI-BOT INPUT PLAUSIBILITY CHECKS (Developer Update, 30 Sep 2026)
 *
 * Layered on top of the existing server replay (ReplayEngine.js) and the
 * existing duration/size checks in ClientSession.js — this only looks at
 * the SHAPE of the discrete launch inputs themselves: how fast they come
 * in, and how regular their timing is, both measured against the server's
 * own frame-derived virtual clock (never a client-claimed timestamp, same
 * rule the rest of _handleRunReport already follows).
 *
 * Returns { rejectReason, flags, detail }:
 *  - rejectReason (string|null): set means the caller should reject the
 *    run outright — a value no real input device/human cadence can
 *    produce (a hard violation, not a judgment call).
 *  - flags (string[]): informational only. Logged via recordAntiCheatAlert
 *    for admin review, never blocks crediting the run — a rare genuine
 *    coincidence is possible, so a human decides, not an auto-ban (see the
 *    Developer Update: "flag suspicious accounts for admin review rather
 *    than auto-banning").
 */
export function analyzeInputPlausibility({ inputs, frames }) {
  const flags = []
  const detail = {}

  if (!Array.isArray(inputs) || inputs.length === 0 || !Array.isArray(frames)) {
    return { rejectReason: null, flags, detail }
  }

  // Per-frame cumulative virtual-time offsets — the exact same dt-to-ms
  // conversion _handleRunReport already uses to validate claimedVirtualMs,
  // so an input's "time" here always agrees with the run's own duration
  // check rather than using a second, possibly-inconsistent clock.
  const frameTimesMs = []
  let acc = 0
  for (let i = 0; i < frames.length; i += 1) {
    frameTimesMs.push(acc)
    const raw = Number(frames[i])
    acc += (Number.isFinite(raw) && raw > 0 ? Math.min(3, raw) : 1) * 16.667
  }

  const sorted = [...inputs].sort((a, b) => (Number(a?.atFrame) || 0) - (Number(b?.atFrame) || 0))
  const times = sorted.map((inp) => {
    const idx = Math.max(0, Math.min(frameTimesMs.length - 1, Number(inp?.atFrame) || 0))
    return frameTimesMs[idx] ?? 0
  })

  // ---- 1) Launch values outside human/device limits ----
  for (const inp of sorted) {
    const dx = Number(inp?.dx) || 0
    const dy = Number(inp?.dy) || 0
    const magnitude = Math.hypot(dx, dy)
    if (magnitude > LAUNCH_MAGNITUDE_REJECT_PX) {
      detail.launchMagnitude = magnitude
      return { rejectReason: 'implausible_launch_values', flags, detail }
    }
  }

  // ---- 2) Input rate / reaction time outside human limits ----
  const intervals = []
  for (let i = 1; i < times.length; i += 1) intervals.push(times[i] - times[i - 1])

  if (intervals.length > 0) {
    const fastest = Math.min(...intervals)
    if (fastest < MIN_HUMAN_INPUT_INTERVAL_MS) {
      detail.fastestIntervalMs = fastest
      return { rejectReason: 'implausible_input_rate', flags, detail }
    }
  }

  // ---- 3) Scripted movement: perfectly regular input timing ----
  if (intervals.length >= SCRIPTED_TIMING_MIN_SAMPLE) {
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length
    const stddev = Math.sqrt(variance)
    if (stddev < SCRIPTED_TIMING_MAX_STDDEV_MS) {
      flags.push('scripted_input_timing')
      detail.inputTimingStddevMs = stddev
      detail.inputCount = intervals.length + 1
    }
  }

  return { rejectReason: null, flags, detail }
}

/**
 * A compact, order-and-timing-sensitive fingerprint of a run's discrete
 * inputs — rounded enough to ignore float noise, precise enough that two
 * genuinely independent human play sessions essentially never collide on
 * it by chance. Used only to flag an EXACT repeat of the same input
 * sequence across two of a player's own runs (a strong replay/bot signal —
 * a real player's drags are never pixel-and-frame identical twice); never
 * used to reject a run on its own, only to flag it for admin review (see
 * Developer Update: "flag scripted movement ... identical input patterns
 * across runs"). Not a cryptographic hash — this never needs to resist a
 * determined forger, only to catch an accidental or careless exact replay.
 */
export function hashInputPattern(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return null
  const sorted = [...inputs].sort((a, b) => (Number(a?.atFrame) || 0) - (Number(b?.atFrame) || 0))
  let prevFrame = 0
  const parts = sorted.map((inp) => {
    const atFrame = Number(inp?.atFrame) || 0
    const dx = Math.round(Number(inp?.dx) || 0)
    const dy = Math.round(Number(inp?.dy) || 0)
    const delta = atFrame - prevFrame
    prevFrame = atFrame
    return `${delta}:${dx}:${dy}`
  })
  const str = parts.join('|')
  let hash = 0
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0
  }
  return `${parts.length}:${hash}`
}
