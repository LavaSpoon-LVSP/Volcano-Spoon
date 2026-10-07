/**
 * COMBO SYSTEM — Volcano Spoon
 * Tracks sequential lava orb hits → score multiplier tiers x1/x2/x3/x5/x10
 * Combo breaks on: bad_rock | fire_wall | timeout (4s) | hazard
 */
import { COMBO_THRESHOLDS, COMBO_MULTIPLIERS, COMBO_TIMEOUT_MS } from './constants.js'

export class ComboSystem {
  constructor() { this.reset() }

  reset() {
    this.count        = 0
    this.multiplier   = 1
    this.tier         = 0
    this.lastOrbMs    = 0
    this.totalBroken  = 0
    this.maxCombo     = 0
    this.isBroken     = false
    this.justTieredUp = false
    this.peakTier     = 0
  }

  onLavaOrb(now) {
    this.lastOrbMs = now
    this.count++
    this.isBroken  = false
    if (this.count > this.maxCombo) this.maxCombo = this.count
    const prevTier    = this.tier
    this.tier         = this._calcTier(this.count)
    this.multiplier   = COMBO_MULTIPLIERS[this.tier]
    if (this.tier > this.peakTier) this.peakTier = this.tier
    this.justTieredUp = this.tier > prevTier
    return { multiplier: this.multiplier, tier: this.tier, count: this.count, tieredUp: this.justTieredUp }
  }

  onTurboLavaOrb(now) {
    this.onLavaOrb(now)
    return this.onLavaOrb(now)
  }

  breakCombo(reason = 'unknown') {
    if (this.count === 0) return
    this.totalBroken++
    this.isBroken     = true
    this.count        = 0
    this.tier         = 0
    this.multiplier   = 1
    this.justTieredUp = false
  }

  /**
   * @param {number} now
   * @param {number} [timeoutMs] - overrides COMBO_TIMEOUT_MS for this
   *   check — used by GameLogic to apply the Maya Sun Artifact perk's
   *   ARTIFACT_COMBO_DURATION_MULTIPLIER (see constants.js's "NFT ARTIFACT
   *   PERKS" section) without this class needing to know about perks
   *   itself. Defaults to the normal fixed timeout when omitted.
   */
  update(now, timeoutMs = COMBO_TIMEOUT_MS) {
    if (this.count > 0 && this.lastOrbMs > 0 && now - this.lastOrbMs > timeoutMs) {
      this.breakCombo('timeout')
      return true
    }
    this.justTieredUp = false
    return false
  }

  /**
   * Break the combo the way a world-event hazard hit does (fire wall /
   * lava stick, wall spikes, ninja knives, a lava-rain drop) — distinct
   * from breakCombo('bad_rock')/('timeout') because the Dino Fossil
   * Artifact perk (comboStabilize) can cushion THIS kind of break: instead
   * of resetting to zero, it keeps `retention` (0..1) of the current hit
   * count, matching ARTIFACT_COMBO_STABILIZE_RETENTION in constants.js.
   * `retention` should be 0 when the perk isn't active, which behaves
   * identically to a normal breakCombo('hazard').
   */
  breakOnHazard(retention = 0) {
    if (this.count === 0) return
    this.totalBroken++
    this.isBroken     = true
    const keep         = retention > 0 ? Math.floor(this.count * retention) : 0
    this.count         = keep
    this.tier          = keep > 0 ? this._calcTier(keep) : 0
    this.multiplier    = COMBO_MULTIPLIERS[this.tier]
    this.justTieredUp  = false
  }

  getState() {
    return {
      count: this.count, multiplier: this.multiplier, tier: this.tier,
      maxCombo: this.maxCombo, isBroken: this.isBroken, tieredUp: this.justTieredUp,
      peakTier: this.peakTier, totalBroken: this.totalBroken,
    }
  }

  getProgressToNextTier() {
    if (this.tier >= COMBO_THRESHOLDS.length - 1) return { current: this.count, needed: this.count, atMax: true }
    const needed = COMBO_THRESHOLDS[this.tier + 1]
    return { current: this.count, needed, atMax: false }
  }

  _calcTier(count) {
    let tier = 0
    for (let i = COMBO_THRESHOLDS.length - 1; i >= 0; i--) {
      if (count >= COMBO_THRESHOLDS[i]) { tier = i; break }
    }
    return tier
  }
}

export default ComboSystem
