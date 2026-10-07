import express from 'express'
import { User } from '../models/User.js'
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
 * Builds the /api/badges router — server-side badge/achievement
 * persistence. Previously badges were written ONLY to
 * `localStorage['vs_badges_' + username]` in the browser (see the old
 * saveBadge()/loadBadges() in Game.jsx / ProfilePanel.jsx), which meant a
 * player lost their earned badges the moment they switched browsers or
 * devices, or cleared site data. This router makes the User document the
 * source of truth instead; localStorage may still be used as a
 * same-device instant-UI cache, but the server list is authoritative.
 *
 * A badge is detected client-side — same trusted-client pattern already
 * used elsewhere for non-economy events like tutorial_orb_collected — and
 * reported here to be centrally recorded. This intentionally does NOT get
 * the heavier replay-validated anti-cheat treatment that coins/XP/NFTs
 * get (see ReplayEngine.js): a badge has no payout attached, so the worst
 * case of a bad report is a cosmetic badge appearing early or incorrectly,
 * not an economy exploit.
 *
 * GET  /me    → auth: this user's earned badges ({ badges: [{id, earnedAt}] }).
 * POST /earn  → auth: { badgeId } — idempotently records a badge as earned.
 *               No-op (still 200) if already recorded or badgeId is unknown/missing
 *               is a 400 so the client can tell the two cases apart.
 */
export function createBadgesRouter(jwtSecret) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  router.get('/me', auth, async (req, res) => {
    try {
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

      // Atomic, idempotent write: only push if this badge id isn't already
      // present, mirroring the same $ne-guard concurrency pattern used
      // elsewhere in this app (e.g. the NFT catalog purchase guard) — a
      // duplicate or racing 'earn' report for the same badge is a safe
      // no-op rather than a duplicate array entry.
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
