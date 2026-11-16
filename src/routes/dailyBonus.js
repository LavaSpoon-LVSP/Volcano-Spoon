import express from 'express'
import { User } from '../models/User.js'
import { getBonusConfig, updateBonusConfig, MAX_DAILY_BONUS_COINS } from '../models/BonusConfig.js'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { auditAdmin, loadConfig } from '../admin/adminAuditLog.js'

/**
 * Optional daily coin bonus (OFF by default, admin-controlled).
 *
 * GET  /me            auth  -> { enabled, coins, claimable }
 * POST /claim         auth  -> grants dailyBonusCoins once per UTC day (atomic; double-click safe)
 * GET  /admin/config  admin
 * PUT  /admin/config  admin -> { dailyBonusEnabled?, dailyBonusCoins? }
 *
 * The amount always comes from the server config, never from the request.
 */
function startOfUtcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

export function createDailyBonusRouter(jwtSecret, sessions) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  router.get('/me', auth, async (req, res) => {
    try {
      const [config, user] = await Promise.all([
        getBonusConfig(),
        User.findById(req.user.sub).select('lastDailyBonusAt').lean(),
      ])
      const claimable = Boolean(config.dailyBonusEnabled) &&
        (!user?.lastDailyBonusAt || user.lastDailyBonusAt < startOfUtcDay())
      res.json({ enabled: Boolean(config.dailyBonusEnabled), coins: config.dailyBonusCoins, claimable })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  router.post('/claim', auth, async (req, res) => {
    try {
      const config = await getBonusConfig()
      if (!config.dailyBonusEnabled) return res.status(403).json({ message: 'Daily bonus is not active' })
      const today = startOfUtcDay()
      const updated = await User.findOneAndUpdate(
        { _id: req.user.sub, $or: [{ lastDailyBonusAt: null }, { lastDailyBonusAt: { $exists: false } }, { lastDailyBonusAt: { $lt: today } }] },
        { $inc: { coins: config.dailyBonusCoins }, $set: { lastDailyBonusAt: new Date() } },
        { new: true },
      ).select('coins')
      if (!updated) return res.status(409).json({ message: 'Already claimed today' })
      const session = sessions?.get(String(req.user.sub))
      if (session?.refresh) void session.refresh()
      res.json({ granted: config.dailyBonusCoins, totalCoins: updated.coins })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  router.get('/admin/config', auth, requireAdmin, async (_req, res) => {
    try { res.json({ config: await getBonusConfig() }) } catch (e) { res.status(500).json({ message: e.message }) }
  })

  router.put('/admin/config', auth, requireAdmin, auditAdmin('config_daily_bonus_update', { before: loadConfig(getBonusConfig) }), async (req, res) => {
    try {
      const body = req.body ?? {}
      const patch = {}
      if (body.dailyBonusEnabled !== undefined) patch.dailyBonusEnabled = Boolean(body.dailyBonusEnabled)
      if (body.dailyBonusCoins !== undefined) {
        const n = Number(body.dailyBonusCoins)
        if (!Number.isInteger(n) || n < 1 || n > MAX_DAILY_BONUS_COINS) {
          return res.status(400).json({ message: `dailyBonusCoins must be a whole number from 1 to ${MAX_DAILY_BONUS_COINS}` })
        }
        patch.dailyBonusCoins = n
      }
      res.json({ config: await updateBonusConfig(patch) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}
