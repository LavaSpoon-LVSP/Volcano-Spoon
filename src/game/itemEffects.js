/**
 * ITEM EFFECTS REGISTRY — the single source of truth for which in-game
 * Item `properties.effect` values actually DO something.
 *
 * Item.js's `properties` field is intentionally free-form (an admin can
 * type anything into it), but until this file, nothing on the server ever
 * read that field — POST /api/items/use just decremented inventory. That
 * meant an admin could describe any benefit in an item's `description`
 * (e.g. "Restores 5 Energy") and the game would sell/grant it while
 * literally doing nothing when "used" — see A25 in the reviewed handover:
 * "The 'use' action is hidden for items that have no defined effect.
 * Benefit claims that are not delivered are removed."
 *
 * This registry is the boundary between "an admin typed something into
 * properties.effect" and "the game actually does that thing." Only an
 * effect type listed in EFFECT_HANDLERS is ever treated as real:
 * - `getImplementedEffectSummary(properties)` is what routes/items.js uses
 *   to decide whether to show/allow the "Use" action for a given item at
 *   all (both in the catalog/inventory JSON and in the /use route itself).
 * - `applyItemEffect(userId, properties)` actually performs the effect,
 *   called only after that check has already passed.
 *
 * Adding a new real effect later means: add a case here, nothing else in
 * routes/items.js needs to change. An item with `properties.effect` set to
 * anything NOT in this registry (or with no `effect` at all — a purely
 * cosmetic/collectible item) correctly has no usable effect and its "Use"
 * action stays hidden, no matter what its description claims.
 */
import { grantEnergyFromItem } from './EnergyService.js'

/**
 * Each handler: (userId, properties) => Promise<{ message, ...details }>
 * Should throw (or reject) on failure — routes/items.js is responsible for
 * turning that into an HTTP error and NOT decrementing/refunding
 * inventory as appropriate.
 */
const EFFECT_HANDLERS = {
  /**
   * properties: { effect: 'energy_refill', amount: <positive integer> }
   * Grants Energy immediately (capped at the live EnergyConfig.maxEnergy,
   * same clamp every other Energy-granting path uses).
   */
  energy_refill: {
    describe(properties) {
      const amount = normalizedEnergyAmount(properties)
      return amount ? { type: 'energy_refill', amount, label: `Restores ${amount} Energy` } : null
    },
    async apply(userId, properties) {
      const amount = normalizedEnergyAmount(properties)
      if (!amount) throw Object.assign(new Error('Item has no valid energy amount configured'), { status: 400 })
      const energy = await grantEnergyFromItem(userId, amount)
      return { message: `Restored ${amount} Energy`, energy }
    },
  },
}

function normalizedEnergyAmount(properties) {
  const amount = Number(properties?.amount)
  if (!Number.isInteger(amount) || amount <= 0) return null
  // Sanity ceiling so a typo (e.g. amount: 99999) can't be used to bypass
  // the Daily Energy System's whole purpose. Matches the largest existing
  // LSVP-purchasable grant (+10) with a little headroom.
  return Math.min(amount, 25)
}

/**
 * Returns a small { type, amount, label } summary if `properties` describes
 * an effect this server can actually deliver, or `null` otherwise (no
 * `effect` key at all, an effect type nothing implements, or one with
 * invalid/missing parameters — e.g. amount: 0). Safe to call with any
 * shape of `properties`, including `{}`/`undefined`.
 */
export function getImplementedEffectSummary(properties) {
  const effectType = properties?.effect
  if (!effectType || typeof effectType !== 'string') return null
  const handler = EFFECT_HANDLERS[effectType]
  if (!handler) return null
  return handler.describe(properties) ?? null
}

/**
 * Actually performs an item's effect. Callers MUST have already confirmed
 * `getImplementedEffectSummary(properties)` is non-null — this throws if
 * called for an item with no implemented effect, so it can never silently
 * do nothing while still reporting success.
 */
export async function applyItemEffect(userId, properties) {
  const effectType = properties?.effect
  const handler = effectType && EFFECT_HANDLERS[effectType]
  if (!handler || !handler.describe(properties)) {
    throw Object.assign(new Error('This item has no usable effect'), { status: 400 })
  }
  return handler.apply(userId, properties)
}

export default { getImplementedEffectSummary, applyItemEffect }
