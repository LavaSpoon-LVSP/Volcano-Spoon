import express from 'express'
import { User } from '../models/User.js'
import { XpHistory } from '../models/XpHistory.js'
import { getAccountLevelInfo } from '../game/xpLeveling.js'
import { requireAuth } from '../middleware/requireAuth.js'

/**
 * Builds the /api/xp router — the Persistent XP System's read side.
 * Purely additive: XP itself is written by ClientSession.saveXp() at the
 * end of every non-tutorial game (see ClientSession.js), never here. This
 * router only ever reads the live, DB-stored value so the Profile page
 * always reflects the latest total, exactly as required.
 *
 * GET /me → auth: totalXp, derived Account Level info, lastXpUpdate,
 *           and recent per-game XP history.
 */
export function createXpRouter(jwtSecret) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  router.get('/me', auth, async (req, res) => {
    try {
      const user = await User.findById(req.user.sub).select('totalXp lastXpUpdate')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }

      const totalXp = user.totalXp || 0
      const levelInfo = getAccountLevelInfo(totalXp)
      const history = await XpHistory.find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(20)

      res.json({
        totalXp,
        lastXpUpdate: user.lastXpUpdate,
        ...levelInfo,
        history: history.map((h) => ({
          id: String(h._id),
          xpEarned: h.xpEarned,
          totalXpAfter: h.totalXpAfter,
          score: h.score,
          createdAt: h.createdAt,
        })),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

export default createXpRouter
