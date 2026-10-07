/**
 * DAILY ENERGY SYSTEM — service layer (additive anti-farming feature)
 *
 * Does NOT touch existing gameplay mechanics, rewards, Lava Coin earning,
 * NFTs, LSVP systems, or arena progression — it only gates how many game
 * RUNS a player may START per day, on top of everything else working
 * exactly as before.
 *
 * Every function here re-fetches the live admin config (see
 * models/EnergyConfig.js) so retuning maxEnergy/regen/costs never requires
 * a redeploy. All balance-affecting writes (consume, purchase) use an
 * atomic `findOneAndUpdate` guard — same idiom as the LSVP-spend routes
 * (jackpot.js, cashout.js) — so a double-submit/race can never go negative
 * or double-spend LSVP.
 */
import { User } from '../models/User.js'
import { getEnergyConfig } from '../models/EnergyConfig.js'
import { EnergyTransaction } from '../models/EnergyTransaction.js'

/** YYYY-MM-DD for `date` as seen in IANA timezone `timeZone`. */
function dateKeyInTimezone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date)
  } catch {
    // Unknown/invalid timezone string from a bad admin edit — fall back to
    // UTC rather than throwing and blocking every game start.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date)
  }
}

/**
 * Pure calculation: given a user's current energy fields and the live
 * config, work out what SHOULD be persisted right now (daily reset and/or
 * regen ticks that have accumulated since the last settle). Returns null if
 * nothing needs to change.
 */
function computeSettlement(user, config, now) {
  const maxEnergy = config.maxEnergy

  // ── Daily reset (checked first — a fresh day always wins over regen
  // math, and resets energyLastRegenAt too so regen starts counting fresh
  // from a full tank) ──
  if (config.dailyResetEnabled) {
    const todayKey = dateKeyInTimezone(now, config.dailyResetTimezone)
    const lastResetKey = dateKeyInTimezone(user.energyLastDailyResetAt || 0, config.dailyResetTimezone)
    if (todayKey !== lastResetKey) {
      return {
        energy: maxEnergy,
        energyLastRegenAt: now,
        energyLastDailyResetAt: now,
        resetHappened: true,
      }
    }
  }

  // ── Passive regen: +1 every regenIntervalMinutes, capped at maxEnergy ──
  if (config.regenEnabled && user.energy < maxEnergy) {
    const intervalMs = Math.max(1, config.regenIntervalMinutes) * 60000
    const lastRegenAt = user.energyLastRegenAt ? new Date(user.energyLastRegenAt).getTime() : now
    const elapsedMs = now - lastRegenAt
    const ticks = Math.floor(elapsedMs / intervalMs)
    if (ticks > 0) {
      const newEnergy = Math.min(maxEnergy, user.energy + ticks)
      // Preserve the remainder toward the next tick (advance by exactly
      // `ticks * intervalMs`, not to `now`) — UNLESS the tank is now full,
      // in which case there's nothing to keep counting toward.
      const newLastRegenAt = newEnergy >= maxEnergy ? now : lastRegenAt + ticks * intervalMs
      return {
        energy: newEnergy,
        energyLastRegenAt: newLastRegenAt,
        regenTicks: ticks,
      }
    }
  }

  return null
}

/**
 * Re-syncs a user's energy against the live config (daily reset + regen
 * ticks) and persists the result if anything changed. Always returns the
 * up-to-date public state. Safe to call as often as needed (idempotent —
 * a no-op settlement just re-reads the current values).
 */
export async function settleUserEnergy(userId) {
  // .lean() here (raw driver document, no Mongoose hydration) so a MISSING
  // field reads as genuinely `undefined` — a hydrated Mongoose document
  // would silently substitute the schema's `default: Date.now` INSTEAD,
  // and since that default is evaluated fresh on every single query (not
  // persisted), any account that predates this feature (so never actually
  // got energyLastRegenAt written to its DB row) would appear to have
  // "just regenerated" on every read — which is exactly the "resets to
  // 30 minutes on every refresh" bug this backfill fixes. Once backfilled
  // below, the real stored timestamp is used from then on.
  const [rawUser, config] = await Promise.all([
    User.findById(userId).select('energy energyLastRegenAt energyLastDailyResetAt unlimitedEnergyUntil').lean(),
    getEnergyConfig(),
  ])
  if (!rawUser) return null

  const now = Date.now()
  const needsBackfill = rawUser.energyLastRegenAt == null || rawUser.energyLastDailyResetAt == null || rawUser.energy == null
  let user = rawUser

  if (needsBackfill) {
    const backfill = {}
    if (rawUser.energy == null) backfill.energy = config.maxEnergy
    if (rawUser.energyLastRegenAt == null) backfill.energyLastRegenAt = new Date(now)
    if (rawUser.energyLastDailyResetAt == null) backfill.energyLastDailyResetAt = new Date(now)
    const updated = await User.findByIdAndUpdate(userId, { $set: backfill }, { new: true })
      .select('energy energyLastRegenAt energyLastDailyResetAt unlimitedEnergyUntil')
      .lean()
    user = updated || { ...rawUser, ...backfill }
  }

  const settlement = computeSettlement(user, config, now)

  let energy = user.energy
  let unlimitedEnergyUntil = user.unlimitedEnergyUntil

  if (settlement) {
    // Conditional write — only apply this computed settlement if `energy`/
    // `energyLastRegenAt` are STILL exactly what was read above. Without
    // this, a concurrent consume (a game start) or purchase landing
    // between that read and this write would be silently overwritten by
    // this settlement's blind `$set`, discarding whatever the concurrent
    // write just did (handover doc: "make the settle write conditional,
    // so it can't overwrite a concurrent consume or purchase"). Losing
    // this race just means this particular settle was a no-op — there's
    // always a next settleUserEnergy call (every gate/purchase/GET /me
    // calls this first), which recomputes from the now-current values.
    const updated = await User.findOneAndUpdate(
      {
        _id: userId,
        energy: user.energy,
        energyLastRegenAt: user.energyLastRegenAt ? new Date(user.energyLastRegenAt) : null,
      },
      {
        $set: {
          energy: settlement.energy,
          energyLastRegenAt: new Date(settlement.energyLastRegenAt),
          ...(settlement.energyLastDailyResetAt ? { energyLastDailyResetAt: new Date(settlement.energyLastDailyResetAt) } : {}),
        },
      },
      { new: true }
    ).select('energy energyLastRegenAt unlimitedEnergyUntil')

    if (updated) {
      energy = updated.energy
      unlimitedEnergyUntil = updated.unlimitedEnergyUntil
      if (settlement.resetHappened) {
        EnergyTransaction.create({ userId, type: 'daily_reset', energyAfter: energy }).catch(() => {})
      }
    } else {
      // Lost the race — read the current, post-concurrent-write state
      // instead of reporting this now-stale computed settlement back to
      // the caller.
      const fresh = await User.findById(userId).select('energy energyLastRegenAt unlimitedEnergyUntil').lean()
      if (fresh) {
        energy = fresh.energy
        unlimitedEnergyUntil = fresh.unlimitedEnergyUntil
      }
    }
  }

  const unlimitedActive = Boolean(unlimitedEnergyUntil) && new Date(unlimitedEnergyUntil).getTime() > now
  const intervalMs = Math.max(1, config.regenIntervalMinutes) * 60000
  const nextRegenAt = config.regenEnabled && energy < config.maxEnergy
    ? new Date((settlement ? settlement.energyLastRegenAt : (user.energyLastRegenAt ? new Date(user.energyLastRegenAt).getTime() : now)) + intervalMs)
    : null

  return {
    energy,
    maxEnergy: config.maxEnergy,
    unlimitedActive,
    unlimitedEnergyUntil: unlimitedActive ? unlimitedEnergyUntil : null,
    nextRegenAt,
    regenEnabled: config.regenEnabled,
    regenIntervalMinutes: config.regenIntervalMinutes,
    dailyResetEnabled: config.dailyResetEnabled,
    lsvpCostFive: config.lsvpCostFive,
    lsvpCostTen: config.lsvpCostTen,
    lsvpCostUnlimitedHour: config.lsvpCostUnlimitedHour,
  }
}

/**
 * Call this BEFORE a game run is allowed to start. Settles regen/reset
 * first, then — if Unlimited Energy is active — allows the run for free;
 * otherwise atomically consumes 1 Energy (guarded, race-safe) or rejects.
 * Never trusts the client's claim about its own energy value.
 */
export async function consumeEnergyForRun(userId) {
  const state = await settleUserEnergy(userId)
  if (!state) return { allowed: false, reason: 'User not found' }

  if (state.unlimitedActive) {
    return { allowed: true, ...state }
  }

  if (state.energy < 1) {
    return { allowed: false, reason: 'Out of Energy', ...state }
  }

  const now = Date.now()

  const updated = await User.findOneAndUpdate(
    { _id: userId, energy: { $gte: 1 } },
    [
      {
        $set: {
          // Leaving a full tank (this decrement is the moment energy first
          // drops below maxEnergy) resets the regen clock to NOW. Without
          // this, energyLastRegenAt sits frozen at whenever the tank last
          // became full — nothing touches it while energy stays at max,
          // since computeSettlement's regen branch only runs at all when
          // energy < maxEnergy — so it can go stale for arbitrarily long.
          // The next settle after THIS consume would then see a huge
          // elapsed gap and grant a burst of backlogged regen ticks that
          // jumps straight back to full, silently undoing the Energy this
          // very call just spent (handover doc: "Reset energyLastRegenAt
          // when leaving a full tank").
          energyLastRegenAt: {
            $cond: [{ $eq: ['$energy', state.maxEnergy] }, new Date(now), '$energyLastRegenAt'],
          },
          energy: { $subtract: ['$energy', 1] },
        },
      },
    ],
    { new: true, updatePipeline: true }
  ).select('energy')

  if (!updated) {
    // Lost a race against another consume between the check above and now.
    return { allowed: false, reason: 'Out of Energy', ...state, energy: 0 }
  }

  EnergyTransaction.create({ userId, type: 'consume', energyAfter: updated.energy }).catch(() => {})

  return { allowed: true, ...state, energy: updated.energy }
}

/**
 * Reverses a single 'consume' — used ONLY when a round's Energy charge must
 * be refunded because the round never actually started: the run token was
 * discarded by an immediate retry (a fresh game:restart superseding it) or
 * the socket disconnected, in either case before any game:run_report ever
 * arrived for it (see ClientSession's RUN_START_REFUND_WINDOW_MS usage).
 * Atomic and clamped to maxEnergy (in case passive regen already topped
 * the player back up in the meantime) — grants back at most the single
 * Energy the failed round charged, never more, and never overshoots the
 * cap.
 */
export async function refundEnergyForFailedStart(userId) {
  const config = await getEnergyConfig()

  const updated = await User.findOneAndUpdate(
    { _id: userId },
    [
      {
        $set: {
          energy: { $min: [{ $add: ['$energy', 1] }, config.maxEnergy] },
        },
      },
    ],
    { new: true, updatePipeline: true }
  ).select('energy')

  if (!updated) return null

  EnergyTransaction.create({ userId, type: 'refund', energyAfter: updated.energy }).catch(() => {})

  return updated.energy
}

/**
 * Grant +5 Energy, +10 Energy, or Unlimited Energy (1 Hour). `type` is
 * 'five' | 'ten' | 'unlimited'. The caller (routes/energy.js) has already
 * independently verified a real on-chain LSVP payment for the right amount
 * before calling this — this function only does the granting, no balance
 * guard/deduction anymore (there's no off-chain lsvpBalance left to guard).
 * Still atomic via a pipeline update so a concurrent purchase/consume can
 * never overshoot maxEnergy or race the passive-regen write.
 */
/**
 * Grant a specific amount of Energy from an in-game Item's `use` effect
 * (see game/itemEffects.js). Distinct from `purchaseEnergy` (LSVP-paid,
 * fixed +5/+10/unlimited) and `refundEnergyForFailedStart` (always exactly
 * +1, tied to a specific failed run) — this is an arbitrary, item-defined
 * amount, still atomic and clamped to `maxEnergy` via the same aggregation-
 * pipeline pattern as every other Energy-granting write here, so it can
 * never overshoot the cap or race a concurrent consume/settle.
 */
export async function grantEnergyFromItem(userId, amount) {
  await settleUserEnergy(userId) // reflect regen/reset before adding to it, same as purchaseEnergy

  const config = await getEnergyConfig()
  const safeAmount = Math.max(1, Math.floor(Number(amount) || 0))

  const updated = await User.findOneAndUpdate(
    { _id: userId },
    [
      {
        $set: {
          energy: { $min: [{ $add: ['$energy', safeAmount] }, config.maxEnergy] },
        },
      },
    ],
    { new: true, updatePipeline: true }
  ).select('energy')

  if (!updated) {
    throw Object.assign(new Error('User not found'), { status: 404 })
  }

  EnergyTransaction.create({ userId, type: 'item_grant', energyAfter: updated.energy }).catch(() => {})

  return updated.energy
}

export async function purchaseEnergy(userId, type) {
  await settleUserEnergy(userId) // make sure `energy` reflects regen/reset before adding to it

  const config = await getEnergyConfig()
  const now = Date.now()

  if (type === 'five' || type === 'ten') {
    const amount = type === 'five' ? 5 : 10
    const cost = type === 'five' ? config.lsvpCostFive : config.lsvpCostTen

    const updated = await User.findOneAndUpdate(
      { _id: userId },
      [
        {
          $set: {
            energy: { $min: [{ $add: ['$energy', amount] }, config.maxEnergy] },
          },
        },
      ],
      // updatePipeline: true — required by this Mongoose version to allow
      // passing an update as an aggregation pipeline (an array) instead of
      // a plain $set/$inc object; without it, Mongoose rejects the array
      // outright with "Cannot pass an array to query updates unless the
      // 'updatePipeline' option is set". The pipeline form is what lets
      // this atomically clamp the new Energy value to maxEnergy even if a
      // passive regen tick lands at the same moment.
      { new: true, updatePipeline: true }
    ).select('energy')

    if (!updated) {
      return { success: false, message: 'User not found' }
    }

    EnergyTransaction.create({
      userId, type: 'purchase', purchaseType: type, lsvpSpent: cost, energyAfter: updated.energy,
    }).catch(() => {})

    return { success: true, energy: updated.energy, maxEnergy: config.maxEnergy }
  }

  if (type === 'unlimited') {
    const cost = config.lsvpCostUnlimitedHour

    const updated = await User.findOneAndUpdate(
      { _id: userId },
      [
        {
          $set: {
            // Stack onto remaining time if already active, otherwise start
            // a fresh hour from now.
            unlimitedEnergyUntil: {
              $add: [
                { $cond: [{ $gt: ['$unlimitedEnergyUntil', now] }, '$unlimitedEnergyUntil', now] },
                60 * 60 * 1000,
              ],
            },
          },
        },
      ],
      { new: true, updatePipeline: true } // see the 'five'/'ten' branch above for why this is required
    ).select('unlimitedEnergyUntil')

    if (!updated) {
      return { success: false, message: 'User not found' }
    }

    EnergyTransaction.create({
      userId, type: 'purchase', purchaseType: type, lsvpSpent: cost,
    }).catch(() => {})

    return {
      success: true,
      unlimitedEnergyUntil: updated.unlimitedEnergyUntil,
    }
  }

  return { success: false, message: `Unknown Energy purchase type: ${type}` }
}

export default { settleUserEnergy, consumeEnergyForRun, purchaseEnergy, refundEnergyForFailedStart, grantEnergyFromItem }
