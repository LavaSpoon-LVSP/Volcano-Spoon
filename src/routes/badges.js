import express from 'express'
import { User } from '../models/User.js'
import { RunResult } from '../models/RunResult.js'
import { requireAuth } from '../middleware/requireAuth.js'

// Keep this list in sync with BADGE_DEFS in the frontend (Game.jsx /
// ProfilePanel.jsx). Server-side validation so an arbitrary/unknown id
// can never be recorded, even by a modified client.
const VALID_BADGE_IDS = new Set([
  'first_jackpot',
  'first_mythic',
  'survivor_30',
  'survivor_60',
  'survivor_120',
  'survivor_180',
  'combo_10',
  'combo_25',
  'combo_50',
])

/**
 * 16 Oct 2026 checklist review, row F1: POST /earn previously recorded
 * whatever badgeId the browser sent, as long as it was a known id — so any
 * signed-in player could award themselves every badge with one forged
 * request (live-verified: a fresh suf1 account with no qualifying runs was
 * granted 'survivor_180' with a single POST). That breaks the client's rule
 * that nothing reward-related is trusted from the browser (point 5), same
 * category of bug as the LSVP/NFT/run-report paths.
 *
 * Fix: the server decides whether a badge is earned, by checking the claim
 * against this player's own CONFIRMED (status:'committed') rounds — the
 * same RunResult rows ReplayEngine.replayRun() produced, never anything the
 * client asserts about itself. A badge has no direct payout, but it's still
 * a reward-adjacent claim the client could otherwise fake, so it gets the
 * same "server decides" treatment, just against simpler evidence (one
 * qualifying confirmed round) rather than a full replay.
 *
 * Each badge's requirement (ties to RunResult's server-replayed fields —
 * see ReplayEngine.js / ClientSession._handleRunReport):
 *   first_jackpot → any committed round with jackpotOrbCollected
 *   first_mythic  → any committed round with mythicOrbCollected
 *   survivor_N    → any committed round with survivalMs >= N * 1000
 *   combo_N       → any committed round with maxCombo >= N
 */
export const BADGE_REQUIREMENTS = {
  first_jackpot: () => ({ jackpotOrbCollected: true }),
  first_mythic: () => ({ mythicOrbCollected: true }),
  survivor_30: () => ({ survivalMs: { $gte: 30 * 1000 } }),
  survivor_60: () => ({ survivalMs: { $gte: 60 * 1000 } }),
  survivor_120: () => ({ survivalMs: { $gte: 120 * 1000 } }),
  survivor_180: () => ({ survivalMs: { $gte: 180 * 1000 } }),
  combo_10: () => ({ maxCombo: { $gte: 10 } }),
  combo_25: () => ({ maxCombo: { $gte: 25 } }),
  combo_50: () => ({ maxCombo: { $gte: 50 } }),
}

/**
 * Server-authoritative badge evaluation and award helper.
 * Evaluates a user's confirmed rounds (or the round just settled) against
 * BADGE_REQUIREMENTS and atomically awards any unearned badges into User.badges.
 *
 * @param {string} userId
 * @param {object|null} currentRound - { survivalMs, maxCombo, jackpotOrbCollected, mythicOrbCollected }
 * @returns {Promise<string[]>} Array of newly awarded badge IDs (e.g. ['survivor_30'])
 */
export async function evaluateAndAwardBadgesForUser(userId, currentRound = null) {
  if (!userId) return []
  const user = await User.findById(userId).select('badges')
  if (!user) return []

  const existingBadgeIds = new Set((user.badges || []).map(b => b.id))
  const newBadgeIds = []

  for (const [badgeId, getReq] of Object.entries(BADGE_REQUIREMENTS)) {
    if (existingBadgeIds.has(badgeId)) continue

    let qualifies = false
    if (currentRound) {
      if (badgeId === 'first_jackpot' && currentRound.jackpotOrbCollected) qualifies = true
      else if (badgeId === 'first_mythic' && currentRound.mythicOrbCollected) qualifies = true
      else if (badgeId === 'survivor_30' && (currentRound.survivalMs >= 30 * 1000)) qualifies = true
      else if (badgeId === 'survivor_60' && (currentRound.survivalMs >= 60 * 1000)) qualifies = true
      else if (badgeId === 'survivor_120' && (currentRound.survivalMs >= 120 * 1000)) qualifies = true
      else if (badgeId === 'survivor_180' && (currentRound.survivalMs >= 180 * 1000)) qualifies = true
      else if (badgeId === 'combo_10' && (currentRound.maxCombo >= 10)) qualifies = true
      else if (badgeId === 'combo_25' && (currentRound.maxCombo >= 25)) qualifies = true
      else if (badgeId === 'combo_50' && (currentRound.maxCombo >= 50)) qualifies = true
    }

    if (!qualifies) {
      const requirement = getReq()
      const hasRound = await RunResult.exists({
        userId,
        status: 'committed',
        ...requirement,
      })
      if (hasRound) qualifies = true
    }

    if (qualifies) {
      newBadgeIds.push(badgeId)
      existingBadgeIds.add(badgeId)
    }
  }

  if (newBadgeIds.length > 0) {
    const pushEntries = newBadgeIds.map(id => ({ id, earnedAt: new Date() }))
    await User.updateOne(
      { _id: userId },
      { $push: { badges: { $each: pushEntries } } }
    )
  }

  return newBadgeIds
}

/**
 * Builds the /api/badges router — server-side badge/achievement
 * persistence. Previously badges were written ONLY to
 * `localStorage['vs_badges_' + username]` in the browser (see the old
 * saveBadge()/loadBadges() in Game.jsx / ProfilePanel.jsx), which meant a
 * player lost their earned badges the moment they switched browsers or
 * devices, or cleared site data. This router makes the User document the
 * source of truth instead; localStorage may still be used as a
 * same-device instant-UI cache, but the server list is authoritative.
 *
 * GET  /me    → auth: this user's earned badges ({ badges: [{id, earnedAt}] }).
 * POST /earn  → auth: { badgeId } — the game calls this the moment it
 *               THINKS a badge was earned (same trigger as before), but
 *               the server independently re-checks the claim against this
 *               player's own confirmed rounds before recording anything.
 *               A badgeId whose requirement isn't met yet in any committed
 *               round is REJECTED (400), not recorded — see
 *               BADGE_REQUIREMENTS above. Idempotent/no-op (still 200) if
 *               already recorded.
 */
export function createBadgesRouter(jwtSecret) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  router.get('/me', auth, async (req, res) => {
    try {
      // Catch up on any past committed rounds that qualify for unrecorded badges
      await evaluateAndAwardBadgesForUser(req.user.sub).catch(() => {})
      const user = await User.findById(req.user.sub).select('badges')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }
      res.json({ badges: user.badges ?? [] })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  router.post('/earn', auth, async (req, res) => {
    try {
      const { badgeId } = req.body ?? {}
      if (!badgeId || !VALID_BADGE_IDS.has(badgeId)) {
        return res.status(400).json({ message: 'Unknown or missing badgeId' })
      }

      // SERVER DECIDES: the badge is only recorded if this player has a
      // CONFIRMED (committed) round that meets its requirement. An unearned
      // badge is rejected, never trusted from the browser.
      const alreadyHas = await User.exists({ _id: req.user.sub, 'badges.id': badgeId })
      if (!alreadyHas) {
        const requirement = BADGE_REQUIREMENTS[badgeId]()
        const earned = await RunResult.exists({
          userId: req.user.sub,
          status: 'committed',
          ...requirement,
        })
        if (!earned) {
          return res.status(400).json({ message: 'This badge has not been earned yet' })
        }
      }

      // Atomically persist badge into User.badges in MongoDB if not already recorded.
      // Idempotent write with $ne guard prevents duplicate badge entries.
      await User.updateOne(
        { _id: req.user.sub, 'badges.id': { $ne: badgeId } },
        { $push: { badges: { id: badgeId, earnedAt: new Date() } } }
      )

      const user = await User.findById(req.user.sub).select('badges')
      res.json({ badges: user?.badges ?? [] })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

export default createBadgesRouter
