import mongoose from 'mongoose'

/**
 * Persisted anti-cheat signal — every event that used to be a console.warn
 * only (see ClientSession.js's _handleRunReport / _handleGameRestart) now
 * also lands here, so "is this system under attack right now" is a query,
 * not a grep through server logs that rotate out. Write-heavy, read-rarely
 * (an admin/monitoring dashboard, or an ad-hoc query when investigating a
 * specific user) — kept deliberately small per row and TTL'd so it never
 * becomes an unbounded collection.
 */
const antiCheatAlertSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Best-effort client IP at the time of the event (see server.js's WS
    // upgrade handler) — not authenticated, just a signal for spotting one
    // machine/network hammering multiple accounts.
    ip: {
      type: String,
      default: null,
    },

    // 'restart_rate_limited'        — game:restart throttled (see RateLimiter.js).
    // 'invalid_or_expired_token'    — game:run_report token check failed.
    // 'implausible_duration'        — server-measured run duration outside RUN_TOKEN_MIN_MS/MAX_MS.
    // 'missing_replay_log'          — game:run_report had no frames/inputs to replay.
    // 'replay_log_too_large'        — frames/inputs exceeded ReplayEngine's hard size caps.
    // 'implausible_replay_duration' — claimed virtual duration exceeded real elapsed time.
    // 'replay_failed'               — ReplayEngine.replayRun crashed or returned invalid.
    // 'mismatch'                    — client self-report disagreed with the server's replay
    //                                 (informational — the replay's numbers are what get
    //                                 credited either way, never the client's).
    // ---- Basic anti-bot input checks (Developer Update, 30 Sep 2026 —
    // see game/inputPlausibility.js) ----
    // 'implausible_launch_values'   — a reported drag/launch input's raw magnitude was far
    //                                 beyond anything the real UI can produce (forged payload).
    // 'implausible_input_rate'      — two inputs in the same run landed closer together than
    //                                 any real human drag-release-drag cycle can.
    // 'scripted_input_timing'       — informational — the timing between inputs was close to
    //                                 perfectly regular across enough inputs to look scripted
    //                                 rather than hand-played; never blocks crediting the run.
    // 'duplicate_input_pattern'     — informational — this run's exact input sequence matches
    //                                 one of this player's own earlier runs (see detail.matchedRoundId).
    type: {
      type: String,
      enum: [
        'restart_rate_limited',
        'invalid_or_expired_token',
        'implausible_duration',
        'missing_replay_log',
        'replay_log_too_large',
        'implausible_replay_duration',
        'replay_failed',
        'mismatch',
        'implausible_launch_values',
        'implausible_input_rate',
        'scripted_input_timing',
        'duplicate_input_pattern',
      ],
      required: true,
      index: true,
    },

    // Free-form context for this event (e.g. { elapsedMs, frameCount } for a
    // duration rejection, or { reported, replayed } for a mismatch) — kept
    // as Mixed rather than a rigid schema since every `type` above carries
    // different fields and this is diagnostic data, not gameplay state.
    detail: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

// Diagnostic/monitoring data, not a permanent record — auto-expire after 30
// days so this never needs manual pruning. createdAt comes from timestamps
// above.
antiCheatAlertSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 })

// Fast "is this user currently being flagged a lot" lookups (admin/monitor
// query path).
antiCheatAlertSchema.index({ userId: 1, createdAt: -1 })

export const AntiCheatAlert = mongoose.model('AntiCheatAlert', antiCheatAlertSchema)

export default AntiCheatAlert
