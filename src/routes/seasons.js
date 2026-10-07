import express from 'express'
import { Season } from '../models/Season.js'
import { SeasonScore } from '../models/SeasonScore.js'
import { User } from '../models/User.js'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { syncSeasonStatuses, assertNoOverlap, archiveSeason } from '../game/seasonManager.js'

function serializeSeason(season) {
  return {
    id: String(season._id),
    name: season.name || '',
    startDate: season.startDate,
    endDate: season.endDate,
    status: season.status,
    archivedAt: season.archivedAt,
    createdAt: season.createdAt,
    updatedAt: season.updatedAt,
  }
}

/** Builds `entries` (rank/username/bestScore/totalCoins) for a given
 *  season doc. Active/upcoming seasons join the player's LIVE coin
 *  balance (same behavior the old all-time leaderboard always had);
 *  an ended season instead reads the frozen `totalCoinsSnapshot` written
 *  once at archive time, so its standings never drift afterward. */
async function buildLeaderboardEntries(season, limit = 10) {
  const rows = await SeasonScore.find({ seasonId: season._id })
    .sort({ bestScore: -1 })
    .limit(limit)

  let coinsByUserId = new Map()
  if (season.status !== 'ended') {
    const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('coins')
    coinsByUserId = new Map(users.map((u) => [String(u._id), u.coins || 0]))
  }

  return rows.map((row, index) => ({
    rank: index + 1,
    userId: String(row.userId),
    username: row.username,
    bestScore: row.bestScore,
    totalGames: 1,
    avgScore: row.bestScore,
    totalCoins: season.status === 'ended'
      ? (row.totalCoinsSnapshot ?? 0)
      : (coinsByUserId.get(String(row.userId)) ?? 0),
  }))
}

/**
 * Builds the /api/seasons router — the Seasonal Leaderboard system.
 * Public reads: current season + its live leaderboard, season history
 * list, and any single season's (possibly archived) standings. Admin-only
 * writes: create/edit/end a season. See seasonManager.js for the
 * lifecycle/archiving logic these routes lean on.
 */
export function createSeasonsRouter(jwtSecret) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  /**
   * GET /api/seasons/current
   * Public — the currently active season (with its live top-10), or, if
   * none is active, the next upcoming one (if any) so the UI can say
   * "next season starts <date>" instead of just a bare "no season" message.
   */
  router.get('/current', async (_req, res) => {
    try {
      await syncSeasonStatuses()

      const active = await Season.findOne({ status: 'active' })
      if (active) {
        const entries = await buildLeaderboardEntries(active)
        return res.json({ season: serializeSeason(active), entries })
      }

      const upcoming = await Season.findOne({ status: 'upcoming' }).sort({ startDate: 1 })
      return res.json({ season: null, upcoming: upcoming ? serializeSeason(upcoming) : null, entries: [] })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/seasons/history
   * Public — every ended (archived) season, newest first. Read-only list
   * for the Season History UI; fetch a specific season's frozen standings
   * via GET /api/seasons/:id/leaderboard.
   */
  router.get('/history', async (_req, res) => {
    try {
      await syncSeasonStatuses()
      const seasons = await Season.find({ status: 'ended' }).sort({ endDate: -1 }).limit(200)
      res.json({ seasons: seasons.map(serializeSeason) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/seasons/:id/leaderboard
   * Public — standings for one specific season (active or ended). Ended
   * seasons return the permanently-frozen archive; this never changes
   * after archiving even if a player's coin balance changes later.
   */
  router.get('/:id/leaderboard', async (req, res) => {
    try {
      await syncSeasonStatuses()
      const season = await Season.findById(req.params.id)
      if (!season) {
        return res.status(404).json({ message: 'Season not found' })
      }
      const entries = await buildLeaderboardEntries(season, 100)
      res.json({ season: serializeSeason(season), entries })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/seasons/admin/all
   * Admin only — every season regardless of status, for the Season
   * Management dashboard (create/edit/end UI).
   */
  router.get('/admin/all', auth, requireAdmin, async (_req, res) => {
    try {
      await syncSeasonStatuses()
      const seasons = await Season.find().sort({ startDate: -1 }).limit(500)
      res.json({ seasons: seasons.map(serializeSeason) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/seasons/admin
   * Admin only — create a new season. Body: { name?, startDate, endDate }.
   * Rejected if it would overlap any season that hasn't ended yet — only
   * one season may be upcoming/active for a given window at a time.
   */
  router.post('/admin', auth, requireAdmin, async (req, res) => {
    try {
      const { name, startDate, endDate } = req.body ?? {}
      const start = new Date(startDate)
      const end = new Date(endDate)

      if (!startDate || Number.isNaN(start.getTime())) {
        return res.status(400).json({ message: 'A valid startDate is required' })
      }
      if (!endDate || Number.isNaN(end.getTime())) {
        return res.status(400).json({ message: 'A valid endDate is required' })
      }
      if (end <= start) {
        return res.status(400).json({ message: 'endDate must be after startDate' })
      }

      await assertNoOverlap({ startDate: start, endDate: end })

      const now = new Date()
      const status = now < start ? 'upcoming' : now < end ? 'active' : 'ended'

      const season = await Season.create({
        name: typeof name === 'string' ? name.trim() : '',
        startDate: start,
        endDate: end,
        status,
      })

      res.status(201).json({ season: serializeSeason(season) })
    } catch (error) {
      res.status(400).json({ message: error.message })
    }
  })

  /**
   * PUT /api/seasons/admin/:id
   * Admin only — edit a season's name/dates. Only allowed while the
   * season is still 'upcoming' (hasn't started) — once active or ended,
   * its dates are locked, so live/archived standings can never be
   * retroactively reinterpreted under a different window.
   */
  router.put('/admin/:id', auth, requireAdmin, async (req, res) => {
    try {
      await syncSeasonStatuses()
      const season = await Season.findById(req.params.id)
      if (!season) {
        return res.status(404).json({ message: 'Season not found' })
      }
      if (season.status !== 'upcoming') {
        return res.status(409).json({ message: `Cannot edit a season that is already ${season.status}` })
      }

      const { name, startDate, endDate } = req.body ?? {}
      const nextStart = startDate ? new Date(startDate) : season.startDate
      const nextEnd = endDate ? new Date(endDate) : season.endDate

      if (Number.isNaN(nextStart.getTime()) || Number.isNaN(nextEnd.getTime())) {
        return res.status(400).json({ message: 'Invalid startDate/endDate' })
      }
      if (nextEnd <= nextStart) {
        return res.status(400).json({ message: 'endDate must be after startDate' })
      }

      await assertNoOverlap({ startDate: nextStart, endDate: nextEnd, excludeId: season._id })

      if (typeof name === 'string') season.name = name.trim()
      season.startDate = nextStart
      season.endDate = nextEnd

      const now = new Date()
      season.status = now < season.startDate ? 'upcoming' : now < season.endDate ? 'active' : 'ended'

      await season.save()
      res.json({ season: serializeSeason(season) })
    } catch (error) {
      res.status(400).json({ message: error.message })
    }
  })

  /**
   * POST /api/seasons/admin/:id/end
   * Admin only — end a season immediately (rather than waiting for its
   * configured endDate), freezing/archiving it right now. Lets an admin
   * start the next season without waiting out a stale window.
   */
  router.post('/admin/:id/end', auth, requireAdmin, async (req, res) => {
    try {
      const season = await Season.findById(req.params.id)
      if (!season) {
        return res.status(404).json({ message: 'Season not found' })
      }
      if (season.status === 'ended') {
        return res.status(409).json({ message: 'Season has already ended' })
      }

      const now = new Date()
      season.endDate = now
      // status will be finalized by archiveSeason below, but keep the
      // stored value consistent even if archiveSeason somehow no-ops.
      season.status = 'active'
      await season.save()

      const archived = await archiveSeason(season._id, now)
      res.json({ season: serializeSeason(archived) })
    } catch (error) {
      res.status(400).json({ message: error.message })
    }
  })

  /**
   * DELETE /api/seasons/admin/:id
   * Admin only — remove a season that hasn't started yet. Active/ended
   * seasons can never be deleted (archived data must stay intact).
   */
  router.delete('/admin/:id', auth, requireAdmin, async (req, res) => {
    try {
      await syncSeasonStatuses()
      const season = await Season.findById(req.params.id)
      if (!season) {
        return res.status(404).json({ message: 'Season not found' })
      }
      if (season.status !== 'upcoming') {
        return res.status(409).json({ message: `Cannot delete a season that is already ${season.status}` })
      }
      await season.deleteOne()
      res.json({ ok: true })
    } catch (error) {
      res.status(400).json({ message: error.message })
    }
  })

  return router
}
