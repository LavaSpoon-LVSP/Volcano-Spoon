/**
 * POWERUP SYSTEM — Volcano Spoon
 * Active powerup timers and modifiers for: turbo | magnet | freeze | shield | gravity | chaos
 */
import {
  TURBO_DURATION_MS, TURBO_COMBO_MULTIPLIER,
  MAGNET_DURATION_MS, FREEZE_DURATION_MS, FREEZE_SPEED_FACTOR,
  SHIELD_ORB_DURATION_MS, SHIELD_ORB_HITS,
  GRAVITY_ORB_DURATION_MS, GRAVITY_REDUCTION_FACTOR,
} from './constants.js'
import { now as simTime } from './simClock.js'

const CHAOS_SCORE_BOOST      = 150
const CHAOS_REVERSE_MS       = 5000
const CHAOS_SPEED_SPIKE_MS   = 3000
const CHAOS_INVINCIBILITY_MS = 5000

export class PowerupSystem {
  constructor() { this.reset() }

  reset() {
    this.turboActive      = false; this.turboUntil      = 0
    this.magnetActive     = false; this.magnetUntil     = 0
    this.freezeActive     = false; this.freezeUntil     = 0
    this.shieldActive     = false; this.shieldUntil     = 0; this.shieldHitsLeft = 0
    this.gravityActive    = false; this.gravityUntil    = 0
    this.invincibleActive = false; this.invincibleUntil = 0
    this.reverseActive    = false; this.reverseUntil    = 0
    this.speedSpikeActive = false; this.speedSpikeUntil = 0
  }

  activate(type, chaosEffect, now) {
    const t = now ?? simTime()
    let immediate = { scoreBoost: 0, orbRain: 0, hazardBurst: false }
    switch (type) {
      case 'turbo':   this.turboActive = true;   this.turboUntil   = t + TURBO_DURATION_MS; break
      case 'magnet':  this.magnetActive = true;  this.magnetUntil  = t + MAGNET_DURATION_MS; break
      case 'freeze':  this.freezeActive = true;  this.freezeUntil  = t + FREEZE_DURATION_MS; break
      case 'shield':  this.shieldActive = true;  this.shieldUntil  = t + SHIELD_ORB_DURATION_MS; this.shieldHitsLeft = SHIELD_ORB_HITS; break
      case 'gravity': this.gravityActive = true; this.gravityUntil = t + GRAVITY_ORB_DURATION_MS; break
      case 'chaos':   immediate = this._applyChaos(chaosEffect, t); break
    }
    return immediate
  }

  consumeShieldHit() {
    if (!this.shieldActive) return false
    this.shieldHitsLeft--
    if (this.shieldHitsLeft <= 0) this.shieldActive = false
    return true
  }

  update(now) {
    if (this.turboActive      && now >= this.turboUntil)      this.turboActive      = false
    if (this.magnetActive     && now >= this.magnetUntil)     this.magnetActive     = false
    if (this.freezeActive     && now >= this.freezeUntil)     this.freezeActive     = false
    if (this.shieldActive     && now >= this.shieldUntil)     this.shieldActive     = false
    if (this.gravityActive    && now >= this.gravityUntil)    this.gravityActive    = false
    if (this.invincibleActive && now >= this.invincibleUntil) this.invincibleActive = false
    if (this.reverseActive    && now >= this.reverseUntil)    this.reverseActive    = false
    if (this.speedSpikeActive && now >= this.speedSpikeUntil) this.speedSpikeActive = false
  }

  getModifiers() {
    return {
      gravityFactor:   this.gravityActive    ? GRAVITY_REDUCTION_FACTOR : 1.0,
      airControlBonus: this.turboActive      ? 1.5  : 1.0,
      reverseControls: this.reverseActive,
      invincible:      this.invincibleActive || this.shieldActive,
      freezeFactor:    this.freezeActive     ? FREEZE_SPEED_FACTOR : 1.0,
      speedSpike:      this.speedSpikeActive ? 2.5  : 1.0,
      turboComboMult:  this.turboActive      ? TURBO_COMBO_MULTIPLIER : 1.0,
      turboActive:     this.turboActive,
      magnetActive:    this.magnetActive,
      shieldActive:    this.shieldActive,
      freezeActive:    this.freezeActive,
      gravityActive:   this.gravityActive,
    }
  }

  getHudState(now) {
    const t = now ?? simTime()
    const rem = (until) => Math.max(0, until - t)
    return {
      turbo:      this.turboActive      ? rem(this.turboUntil)      : 0,
      magnet:     this.magnetActive     ? rem(this.magnetUntil)     : 0,
      freeze:     this.freezeActive     ? rem(this.freezeUntil)     : 0,
      shield:     this.shieldActive     ? rem(this.shieldUntil)     : 0,
      gravity:    this.gravityActive    ? rem(this.gravityUntil)    : 0,
      invincible: this.invincibleActive ? rem(this.invincibleUntil) : 0,
      reverse:    this.reverseActive    ? rem(this.reverseUntil)    : 0,
    }
  }

  _applyChaos(effect, now) {
    const result = { scoreBoost: 0, orbRain: 0, hazardBurst: false }
    switch (effect) {
      case 'score_boost':     result.scoreBoost = CHAOS_SCORE_BOOST; break
      case 'reverse_controls': this.reverseActive = true; this.reverseUntil = now + CHAOS_REVERSE_MS; break
      case 'speed_spike':     this.speedSpikeActive = true; this.speedSpikeUntil = now + CHAOS_SPEED_SPIKE_MS; break
      case 'orb_rain':        result.orbRain = 10; break
      case 'invincibility':   this.invincibleActive = true; this.invincibleUntil = now + CHAOS_INVINCIBILITY_MS; break
      case 'hazard_burst':    result.hazardBurst = true; break
    }
    return result
  }
}

export default PowerupSystem
