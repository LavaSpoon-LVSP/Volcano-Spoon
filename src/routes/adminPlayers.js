import express from 'express'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { User } from '../models/User.js'
import { AntiCheatAlert } from '../models/AntiCheatAlert.js'
import { AdminAuditLog } from '../models/AdminAuditLog.js'
import { createPendingAdminAction, markAdminActionApplied, markAdminActionFailed } from '../admin/adminAuditLog.js'

// Fields a correction is allowed to touch. Deliberately does NOT include
// energyLastRegenAt/energyLastDailyResetAt/unlimitedEnergyUntil — a manual
// Energy correction only ever changes the `energy` number itself, per the
// feature spec (those timestamp fields are EnergyService's own bookkeeping
// and correcting `energy` should not disturb them).
const CORRECTABLE_FIELDS = new Set(['energy', 'coins', 'totalXp'])

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Shape returned by both search results and the single-player detail view
 * — a quick-glance summary an admin would actually want before deciding
 * whether/what to correct. Detail view (serializePlayerDetail below) adds
 * a few more fields on top of this.
 */
function serializePlayerSummary(user) {
  return {
    id: String(user._id),
    username: user.username,
    email: user.email,
    role: user.role,
    coins: user.coins,
    totalXp: user.totalXp,
    energy: user.energy,
    createdAt: user.createdAt,
    unlockedArenaStagesCount: user.unlockedArenaStages?.length ?? 0,
    ownedNftIdsCount: user.ownedNftIds?.length ?? 0,
  }
}

function serializePlayerDetail(user) {
  return {
    ...serializePlayerSummary(user),
    jackpotTokens: user.jackpotTokens,
    jackpotOrbs: user.jackpotOrbs,
    badgesCount: user.badges?.length ?? 0,
    ownedSkinIdsCount: user.ownedSkinIds?.length ?? 0,
    equippedSkinId: user.equippedSkinId,
    currentArenaStage: user.currentArenaStage,
    solanaWalletAddress: user.solanaWalletAddress ?? null,
    lsvpBalance: user.lsvpBalance,
  }
}

function serializeAuditRow(row) {
  return {
    id: String(row._id),
    adminUsername: row.adminUsername,
    action: row.action,
    targetUsername: row.targetUsername,
    field: row.field,
    before: row.before,
    after: row.after,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
  }
}

/**
 * Builds the /api/admin/players router — player search, per-player detail,
 * per-player Energy/Coins/XP correction (with a required reason), and each
 * player's own slice of the audit trail. Every route is admin-only.
 *
 * Player lookup is by username throughout, matching the existing
 * "admin acts on a player by username" convention already used by
 * routes/items.js's POST /admin/grant (there is no player-id picker
 * anywhere in the admin UI, so this is what an admin actually has on hand
 * from a support conversation).
 *
 * @param {string} jwtSecret
 */
export function createAdminPlayersRouter(jwtSecret) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  /**
   * GET /?q=<string>
   * Search by partial, case-insensitive username or email. Requires at
   * least 2 characters in `q` and caps results at 25 — this is a support
   * lookup tool, not a bulk player-list export.
   */
  router.get('/', auth, requireAdmin, async (req, res) => {
    try {
      const q = (req.query.q ?? '').toString().trim()
      if (q.length < 2) {
        return res.status(400).json({ message: 'q must be at least 2 characters' })
      }

      const pattern = new RegExp(escapeRegExp(q), 'i')
      const users = await User.find({
        $or: [{ username: pattern }, { email: pattern }],
      })
        .sort({ createdAt: -1 })
        .limit(25)

      res.json({ players: users.map(serializePlayerSummary) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /anti-cheat/flagged
   * Basic anti-bot admin review (Developer Update, 30 Sep 2026 — "Flag
   * suspicious accounts for admin review rather than auto-banning"): every
   * account with at least MIN_ALERTS_TO_FLAG anti-cheat alerts in the last
   * FLAG_WINDOW_DAYS, most-alerts-first, so an admin can see who actually
   * needs a look without wading through every one-off/informational alert
   * (a single mismatch or a momentary disconnect is normal noise; a cluster
   * of them on one account is the actual signal). Read-only — this never
   * bans or restricts anyone, it only surfaces who to look at.
   */
  router.get('/anti-cheat/flagged', auth, requireAdmin, async (req, res) => {
    const FLAG_WINDOW_DAYS = 7
    const MIN_ALERTS_TO_FLAG = 3
    try {
      const since = new Date(Date.now() - FLAG_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      const grouped = await AntiCheatAlert.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: '$userId',
            total: { $sum: 1 },
            types: { $push: '$type' },
            lastAt: { $max: '$createdAt' },
          },
        },
        { $match: { total: { $gte: MIN_ALERTS_TO_FLAG } } },
        { $sort: { total: -1 } },
        { $limit: 50 },
      ])

      const users = await User.find({ _id: { $in: grouped.map((g) => g._id) } }).select('username email')
      const usersById = new Map(users.map((u) => [String(u._id), u]))

      const flagged = grouped.map((g) => {
        const counts = {}
        for (const t of g.types) counts[t] = (counts[t] ?? 0) + 1
        const user = usersById.get(String(g._id))
        return {
          userId: String(g._id),
          username: user?.username ?? '(deleted account)',
          email: user?.email ?? null,
          totalAlerts: g.total,
          alertCounts: counts,
          lastAlertAt: g.lastAt,
        }
      })

      res.json({ windowDays: FLAG_WINDOW_DAYS, minAlertsToFlag: MIN_ALERTS_TO_FLAG, flagged })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /:username/anti-cheat
   * This player's own recent anti-cheat alerts, newest first — opened from
   * the flagged-accounts list above, or looked up directly for any player
   * being investigated. Same 30-day TTL window as the alerts themselves.
   */
  router.get('/:username/anti-cheat', auth, requireAdmin, async (req, res) => {
    try {
      const user = await User.findOne({ username: req.params.username.trim() }).select('_id')
      if (!user) {
        return res.status(404).json({ message: `No user found with username "${req.params.username}"` })
      }
      const alerts = await AntiCheatAlert.find({ userId: user._id }).sort({ createdAt: -1 }).limit(100)
      res.json({
        alerts: alerts.map((a) => ({
          type: a.type,
          detail: a.detail,
          ip: a.ip,
          createdAt: a.createdAt,
        })),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

    /**
   * GET /:username
   * Full detail view for one player — loaded by the correction UI before
   * showing the correction form, and by clicking a search result.
   */
  router.get('/:username', auth, requireAdmin, async (req, res) => {
    try {
      const user = await User.findOne({ username: req.params.username.trim() })
      if (!user) {
        return res.status(404).json({ message: `No user found with username "${req.params.username}"` })
      }
      res.json({ player: serializePlayerDetail(user) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /:username/audit-log
   * This player's own slice of the audit trail — every correction (and
   * any future action type that targets a User) ever recorded against
   * them, newest first.
   */
  router.get('/:username/audit-log', auth, requireAdmin, async (req, res) => {
    try {
      const rows = await AdminAuditLog.find({ targetUsername: req.params.username.trim() })
        .sort({ createdAt: -1 })
        .limit(100)
      res.json({ entries: rows.map(serializeAuditRow) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /:username/correct
   * Body: { field: 'energy' | 'coins' | 'totalXp', mode: 'set' | 'delta',
   *         amount: number, reason: string }
   *
   * A required, logged, trusted admin action — NOT a player-facing
   * endpoint, so none of the replay/anti-cheat machinery that gates
   * gameplay-earned coins/XP applies here (see game/ReplayEngine.js for
   * that separate, unrelated system).
   *
   * Sequencing follows the "durable record before the payout" pattern
   * documented on src/models/AdminAuditLog.js: the audit row is created
   * as 'pending' BEFORE the User document is touched, then flipped to
   * 'applied' only once that write actually succeeds (or 'failed' if it
   * didn't) — so a crash mid-correction always leaves a resolvable trail
   * instead of an unlogged change or a logged-but-never-happened one.
   * This project's MongoDB deployment isn't guaranteed to be a replica
   * set, so a multi-document ACID transaction isn't assumed to be
   * available — this ordering is the fallback the original spec called
   * for and works on a standalone Mongo instance too.
   */
  router.post('/:username/correct', auth, requireAdmin, async (req, res) => {
    const username = req.params.username.trim()
    const { field, mode, reason } = req.body ?? {}
    const amount = Number(req.body?.amount)

    if (!CORRECTABLE_FIELDS.has(field)) {
      return res.status(400).json({ message: "field must be one of 'energy', 'coins', 'totalXp'" })
    }
    if (mode !== 'set' && mode !== 'delta') {
      return res.status(400).json({ message: "mode must be 'set' or 'delta'" })
    }
    if (!Number.isFinite(amount)) {
      return res.status(400).json({ message: 'amount must be a finite number' })
    }
    if (!reason?.trim()) {
      return res.status(400).json({ message: 'reason is required' })
    }

    let log
    try {
      const user = await User.findOne({ username })
      if (!user) {
        return res.status(404).json({ message: `No user found with username "${username}"` })
      }

      const before = user[field]
      let after = mode === 'set' ? amount : before + amount
      // Every one of these three fields has `min: 0` on the User schema —
      // clamp here too (rather than letting a negative value 500 on
      // save()) so the response always reflects what was actually stored,
      // and so a correction can never leave a field in a state the rest
      // of the codebase already assumes is impossible.
      if (after < 0) after = 0
      after = Math.round(after)

      log = await createPendingAdminAction({
        adminId: req.user.sub,
        adminUsername: req.user.username,
        action: 'player_correction',
        targetUserId: user._id,
        targetUsername: user.username,
        field,
        before,
        reason: reason.trim(),
        ip: req.ip,
      })

      user[field] = after
      await user.save()

      await markAdminActionApplied(log._id, { after })

      res.json({
        player: serializePlayerDetail(user),
        auditEntry: serializeAuditRow({ ...log.toObject(), after, status: 'applied' }),
      })
    } catch (error) {
      if (log) {
        await markAdminActionFailed(log._id, error.message).catch(() => {})
      }
      res.status(500).json({ message: error.message })
    }
  })

  return router
}
