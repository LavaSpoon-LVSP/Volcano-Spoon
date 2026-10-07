import { Season } from '../models/Season.js'
import { SeasonScore } from '../models/SeasonScore.js'
import { User } from '../models/User.js'

/**
 * Seasonal Leaderboard — season lifecycle helpers.
 *
 * There is no scheduler/cron library in this backend, so season
 * transitions are driven lazily: every request that touches seasons
 * (the public current-season/leaderboard reads, the admin CRUD, and the
 * WebSocket leaderboard:get flow in ClientSession.js) calls
 * syncSeasonStatuses() first. It's cheap (at most a couple of small
 * queries when nothing needs to change) and fully idempotent, so calling
 * it constantly from many places is safe and keeps the system correct
 * without a background process.
 */

/**
 * Rolls any season whose window has actually started/ended into the
 * right stored `status`, archiving anything that just ended. Safe to call
 * as often as you like — every step here is idempotent.
 */
export async function syncSeasonStatuses(now = new Date()) {
  // upcoming -> active (its window has started, and hasn't ended yet)
  await Season.updateMany(
    { status: 'upcoming', startDate: { $lte: now }, endDate: { $gt: now } },
    { $set: { status: 'active' } }
  )

  // Anything (active OR still-upcoming, e.g. an admin set an endDate in
  // the past by mistake, or force-ended it early via /end) whose endDate
  // has passed needs to be archived and marked ended.
  const toEnd = await Season.find({
    status: { $in: ['upcoming', 'active'] },
    endDate: { $lte: now },
  })

  for (const season of toEnd) {
    await archiveSeason(season._id, now)
  }
}

/**
 * Freezes a season's final standings and marks it 'ended'. Idempotent —
 * guarded by `archivedAt`, so calling this twice (e.g. a race between two
 * concurrent requests both running syncSeasonStatuses) is harmless.
 *
 * Freezing means: every SeasonScore row for this season gets a permanent
 * `totalCoinsSnapshot` of that player's coin balance *right now*. From
 * this point on nothing else ever writes to these rows (ClientSession
 * only ever writes to the currently-active season), so the archived
 * leaderboard is provably immutable going forward.
 */
export async function archiveSeason(seasonId, now = new Date()) {
  const season = await Season.findById(seasonId)
  if (!season || season.archivedAt) return season

  const rows = await SeasonScore.find({ seasonId: season._id })
  if (rows.length > 0) {
    const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('coins')
    const coinsByUserId = new Map(users.map((u) => [String(u._id), u.coins || 0]))

    await Promise.all(
      rows.map((row) =>
        SeasonScore.updateOne(
          { _id: row._id },
          { $set: { totalCoinsSnapshot: coinsByUserId.get(String(row.userId)) ?? 0 } }
        )
      )
    )
  }

  season.status = 'ended'
  season.archivedAt = now
  await season.save()
  return season
}

/** The single season currently accepting scores, or null if none. */
export async function getActiveSeason() {
  await syncSeasonStatuses()
  return Season.findOne({ status: 'active' })
}

/**
 * Throws a descriptive Error if [startDate, endDate) would overlap any
 * season that hasn't ended yet (upcoming or active) — enforces "only one
 * active season at a time" / "prevent overlapping active seasons" at
 * creation/edit time, rather than leaving it to chance. `excludeId` lets
 * an edit-in-place check ignore the season being edited.
 */
export async function assertNoOverlap({ startDate, endDate, excludeId } = {}) {
  await syncSeasonStatuses()

  const filter = {
    status: { $in: ['upcoming', 'active'] },
    startDate: { $lt: endDate },
    endDate: { $gt: startDate },
  }
  if (excludeId) {
    filter._id = { $ne: excludeId }
  }

  const clash = await Season.findOne(filter)
  if (clash) {
    throw new Error(
      `Overlaps existing season "${clash.name || clash._id}" (${clash.startDate.toISOString()} – ${clash.endDate.toISOString()})`
    )
  }
}
