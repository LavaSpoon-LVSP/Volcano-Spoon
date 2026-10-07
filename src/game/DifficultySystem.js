/**
 * DIFFICULTY SYSTEM — Volcano Spoon
 *
 * Layer 1 — ADAPTIVE (Hidden): detects struggling players, silently eases gameplay.
 * Layer 2 — PROGRESSIVE: scales orb speed/spawns/gravity over time + combo.
 *
 * Never exposes internal state to UI. getOverrides() feeds the game loop.
 */
import {
  STRUGGLE_DEATH_WINDOW_MS, STRUGGLE_DEATH_THRESHOLD,
  STRUGGLE_SURVIVAL_THRESHOLD, STRUGGLE_COMBO_THRESHOLD,
  DIFF_SCALE_INTERVAL_MS, DIFF_MAX_STAGES,
  DIFF_SPEED_INCREMENT, DIFF_GRAVITY_INCREMENT,
  DIFF_SPAWN_ACCELERATION, DIFF_HAZARD_WEIGHT_BOOST,
  DIFF_START_SPEED_MULTIPLIER, DIFF_START_GRAVITY_MULTIPLIER, DIFF_START_SPAWN_MULTIPLIER,
  ORB_SPAWN_INTERVAL_MS, GRAVITY,
} from './constants.js'
import { now as simTime } from './simClock.js'

export class DifficultySystem {
  constructor() { this.reset() }

  reset() {
    this.stage             = 0
    this.lastScaleMs       = 0
    this.sessionStartMs    = simTime()
    this.spawnIntervalMs   = ORB_SPAWN_INTERVAL_MS * DIFF_START_SPAWN_MULTIPLIER
    this.gravityMultiplier = DIFF_START_GRAVITY_MULTIPLIER
    this.speedMultiplier   = DIFF_START_SPEED_MULTIPLIER
    this.hazardWeightBoost = 1.0
    this._recentDeaths     = []
    this._survivalTimes    = []
    this._maxComboReached  = 0
    this._isStruggling     = false
    this._struggleCooldown = 0
  }

  update(now, comboState) {
    if (this.stage < DIFF_MAX_STAGES && now - this.lastScaleMs > DIFF_SCALE_INTERVAL_MS) {
      this._incrementStage()
      this.lastScaleMs = now
    }
    if (comboState.count > this._maxComboReached) this._maxComboReached = comboState.count
    if (this._struggleCooldown > 0) { this._struggleCooldown-- }
    else { this._evaluateStruggle(now); this._struggleCooldown = 180 }
  }

  recordDeath(survivalMs) {
    const now = simTime()
    this._recentDeaths.push(now)
    this._survivalTimes.push(survivalMs)
    this._recentDeaths = this._recentDeaths.filter(t => now - t < STRUGGLE_DEATH_WINDOW_MS)
  }

  get isStruggling() { return this._isStruggling }

  getOverrides() {
    return {
      speedMultiplier:   this.speedMultiplier   * (this._isStruggling ? 0.80 : 1.0),
      gravityMultiplier: this.gravityMultiplier,
      spawnIntervalMs:   this.spawnIntervalMs   * (this._isStruggling ? 1.35 : 1.0),
      hazardWeightBoost: this.hazardWeightBoost * (this._isStruggling ? 0.50 : 1.0),
      struggling:        this._isStruggling,
      stage:             this.stage,
    }
  }

  getDebugState() {
    return {
      stage: this.stage, isStruggling: this._isStruggling,
      recentDeaths: this._recentDeaths.length,
      speedMultiplier: this.speedMultiplier,
      gravityMultiplier: this.gravityMultiplier,
      spawnIntervalMs: this.spawnIntervalMs,
    }
  }

  _incrementStage() {
    this.stage++
    this.speedMultiplier   = Math.min(this.speedMultiplier   + DIFF_SPEED_INCREMENT,   2.2)
    this.gravityMultiplier = Math.min(this.gravityMultiplier + DIFF_GRAVITY_INCREMENT, 1.6)
    this.spawnIntervalMs   = Math.max(this.spawnIntervalMs   * DIFF_SPAWN_ACCELERATION, 350)
    this.hazardWeightBoost *= DIFF_HAZARD_WEIGHT_BOOST
  }

  _evaluateStruggle(now) {
    const deathsInWindow = this._recentDeaths.filter(t => now - t < STRUGGLE_DEATH_WINDOW_MS).length
    const recent = this._survivalTimes.slice(-5)
    const avgSurvival = recent.length > 0 ? recent.reduce((s, v) => s + v, 0) / recent.length : Infinity
    const wasStruggling = this._isStruggling
    this._isStruggling = (
      deathsInWindow >= STRUGGLE_DEATH_THRESHOLD ||
      (avgSurvival < STRUGGLE_SURVIVAL_THRESHOLD && this._survivalTimes.length >= 2) ||
      (this._maxComboReached < STRUGGLE_COMBO_THRESHOLD && this._survivalTimes.length >= 3)
    )
    if (wasStruggling && !this._isStruggling) this._maxComboReached = 0
  }
}

export default DifficultySystem
