/**
 * LEVEL SYSTEM
 * Data-driven progression controlling orb unlocks and spawn balancing.
 */

// 'black' added to HAZARD_TYPES — Orb Roster Completion (A16) gave it a real
// score-penalty + combo-break effect (see GameLogic._handleOrbCollected's
// 'black' case), same category as bad_rock/fire_wall/chaos for the
// hazardMultiplier scaling below. combo/rose/sun_flame/electric are bonus-
// flavored (never punish the player), so they scale with SUPPORT_TYPES'
// supportMultiplier instead, same as health/freeze/shield/magnet/gravity.
const HAZARD_TYPES = new Set(['bad_rock', 'fire_wall', 'chaos', 'black'])
const SUPPORT_TYPES = new Set(['freeze', 'shield', 'magnet', 'gravity', 'health', 'combo', 'rose', 'sun_flame', 'electric'])

const LEVELS = [
  {
    level: 1,
    name: 'Warmup',
    minScore: 0,
    // Kept deliberately unchanged (handover doc: "Level 1 must remain
    // clearly easy and accessible... understand the basic gameplay within
    // seconds") — no hazards, no new orb types, same gentle pacing.
    unlocks: ['lava', 'health', 'diamond'],
    spawnWeights: { lava: 100, health: 1, diamond: 0.15 },
    spawnIntervalMultiplier: 1.18,
    speedMultiplier: 0.88,
    gravityMultiplier: 0.94,
    maxActiveOrbs: 10,
    hazardMultiplier: 0.45,
    supportMultiplier: 1.6,
  },
  {
    level: 2,
    name: 'Cooling Window',
    minScore: 120,
    // Handover doc: "Level 2 must be noticeably more difficult than Level
    // 1... obvious during gameplay, not only through the level label."
    // Previously Level 2 added only freeze/shield (both defensive/support,
    // never punish the player) and nudged hazardMultiplier 0.45→0.5 — a
    // multiplier with nothing to multiply, since bad_rock/fire_wall/chaos
    // don't unlock until Level 3+. There was no actual obstacle here.
    // Now introduces the Black Orb — a real, visually distinct new hazard
    // (see OrbSystem.js's spawnBlackOrb / GameLogic's 'black' case) — as
    // Level 2's first genuine obstacle, plus the Combo Orb for a clearly
    // new *positive* element too. hazardMultiplier/speedMultiplier/
    // spawnIntervalMultiplier/maxActiveOrbs are all stepped up more than
    // before so the pace/pressure jump reads as real, not cosmetic.
    unlocks: ['lava', 'freeze', 'shield', 'black', 'combo', 'health', 'diamond'],
    spawnWeights: { lava: 80, freeze: 9, shield: 6, black: 4, combo: 5, health: 1.2, diamond: 0.2 },
    spawnIntervalMultiplier: 1.0,
    speedMultiplier: 1.0,
    gravityMultiplier: 0.98,
    maxActiveOrbs: 13,
    hazardMultiplier: 0.75,
    supportMultiplier: 1.35,
  },
  {
    level: 3,
    name: 'Magnetic Drift',
    minScore: 280,
    // Rose Orb joins here (heal-flavored bonus, like Health) alongside the
    // existing Magnet/Bad Rock introductions.
    unlocks: ['lava', 'freeze', 'shield', 'magnet', 'bad_rock', 'black', 'combo', 'rose', 'health', 'diamond'],
    spawnWeights: { lava: 70, freeze: 8, shield: 6, magnet: 8, bad_rock: 6, black: 4, combo: 4, rose: 4, health: 1.2, diamond: 0.25 },
    spawnIntervalMultiplier: 1.0,
    speedMultiplier: 0.97,
    gravityMultiplier: 1.0,
    maxActiveOrbs: 12,   
    hazardMultiplier: 0.78,
    supportMultiplier: 1.25,
  },
  {
    level: 4,
    name: 'Thermal Shift',
    minScore: 500,
    // Sun Flame Orb joins here (fast-decaying score-bonus orb) alongside
    // the existing Turbo/Fire Wall introductions.
    unlocks: ['lava', 'freeze', 'shield', 'magnet', 'bad_rock', 'turbo', 'fire_wall', 'black', 'combo', 'rose', 'sun_flame', 'health', 'diamond'],
    spawnWeights: { lava: 60, turbo: 8, freeze: 7, shield: 6, magnet: 7, bad_rock: 6, fire_wall: 4, black: 5, combo: 4, rose: 3, sun_flame: 3, health: 1.3, diamond: 0.3 },
    spawnIntervalMultiplier: 0.94,
    speedMultiplier: 1.02,
    gravityMultiplier: 1.03,
    maxActiveOrbs: 13,
    hazardMultiplier: 0.9,
    supportMultiplier: 1.16,
  },
  {
    level: 5,
    name: 'Gravity Cracks',
    minScore: 800,
    // Electric Shock Orb joins here, completing the full 16-type orb
    // roster (see OrbSystem.js's header comment) well ahead of the
    // Level 6-8 jackpot/chaos/mythic endgame tiers.
    unlocks: ['lava', 'freeze', 'shield', 'magnet', 'bad_rock', 'turbo', 'fire_wall', 'gravity', 'black', 'combo', 'rose', 'sun_flame', 'electric', 'health', 'diamond'],
    spawnWeights: { lava: 54, turbo: 10, freeze: 6, shield: 5, magnet: 6, gravity: 6, bad_rock: 7, fire_wall: 4, black: 5, combo: 3, rose: 3, sun_flame: 3, electric: 3, health: 1.4, diamond: 0.35 },
    spawnIntervalMultiplier: 0.88,
    speedMultiplier: 1.06,
    gravityMultiplier: 1.06,
    maxActiveOrbs: 14,
    hazardMultiplier: 1.02,
    supportMultiplier: 1.07,
  },
  {
    level: 6,
    name: 'Fortune Faultline',
    minScore: 1200,
    unlocks: ['lava', 'freeze', 'shield', 'magnet', 'bad_rock', 'turbo', 'fire_wall', 'gravity', 'jackpot', 'black', 'combo', 'rose', 'sun_flame', 'electric', 'health', 'diamond'],
    spawnWeights: { lava: 48, turbo: 10, jackpot: 3, freeze: 5, shield: 4, magnet: 6, gravity: 6, bad_rock: 10, fire_wall: 6, black: 5, combo: 3, rose: 3, sun_flame: 3, electric: 3, health: 1.5, diamond: 0.45 },
    spawnIntervalMultiplier: 0.82,
    speedMultiplier: 1.1,
    gravityMultiplier: 1.08,
     maxActiveOrbs: 15,
    hazardMultiplier: 1.18,
    supportMultiplier: 1.0,
  },
  {
    level: 7,
    name: 'Chaotic Rift',
    minScore: 1700,
    unlocks: ['lava', 'freeze', 'shield', 'magnet', 'bad_rock', 'turbo', 'fire_wall', 'gravity', 'jackpot', 'chaos', 'black', 'combo', 'rose', 'sun_flame', 'electric', 'health', 'diamond'],
    spawnWeights: { lava: 42, turbo: 10, jackpot: 3, freeze: 4, shield: 3, magnet: 5, gravity: 5, bad_rock: 12, fire_wall: 8, chaos: 6, black: 6, combo: 3, rose: 2, sun_flame: 2, electric: 2, health: 1.5, diamond: 0.5 },
    spawnIntervalMultiplier: 0.76,
    speedMultiplier: 1.14,
     gravityMultiplier: 1.1,
    maxActiveOrbs: 16,
    hazardMultiplier: 1.3,
    supportMultiplier: 0.95,
  },
  {
    level: 8,
    name: 'Mythic Pressure',
    minScore: 2400,
    unlocks: ['lava', 'freeze', 'shield', 'magnet', 'bad_rock', 'turbo', 'fire_wall', 'gravity', 'jackpot', 'chaos', 'mythic', 'black', 'combo', 'rose', 'sun_flame', 'electric', 'health', 'diamond'],
    spawnWeights: { lava: 38, turbo: 11, jackpot: 4, freeze: 3, shield: 3, magnet: 4, gravity: 5, bad_rock: 13, fire_wall: 8, chaos: 8, mythic: 1, black: 6, combo: 2, rose: 2, sun_flame: 2, electric: 2, health: 1.8, diamond: 0.6 },
    spawnIntervalMultiplier: 0.7,
    speedMultiplier: 1.18,
    gravityMultiplier: 1.12,
    maxActiveOrbs: 18,
    hazardMultiplier: 1.38,
    supportMultiplier: 0.9,
  },
]

export class LevelSystem {
  constructor(levels = LEVELS) {
    this.levels = [...levels].sort((a, b) => a.minScore - b.minScore)
    this.reset()
  }

  reset() {
    this.currentIndex = 0
  }

  update(score) {
    let idx = this.currentIndex
    for (let i = 0; i < this.levels.length; i++) {
      if (score >= this.levels[i].minScore) idx = i
      else break
    }
    this.currentIndex = idx
  }

  getCurrentLevel() {
    return this.levels[this.currentIndex]
  }

  getSpawnProfile({ hazardWeightBoost = 1, struggling = false } = {}) {
    const level = this.getCurrentLevel()
    const unlocked = new Set(level.unlocks)

    const hazardMult = (level.hazardMultiplier ?? 1) * hazardWeightBoost * (struggling ? 0.65 : 1)
    const supportMult = (level.supportMultiplier ?? 1) * (struggling ? 1.5 : 1)

    const spawnWeights = {}
    Object.entries(level.spawnWeights).forEach(([type, weight]) => {
      if (!unlocked.has(type)) {
        spawnWeights[type] = 0
        return
      }
      let nextWeight = weight
      if (HAZARD_TYPES.has(type)) nextWeight *= hazardMult
      if (SUPPORT_TYPES.has(type)) nextWeight *= supportMult
      spawnWeights[type] = Math.max(0, nextWeight)
    })

    return {
      unlockedTypes: [...unlocked],
      spawnWeights,
      spawnIntervalMultiplier: level.spawnIntervalMultiplier ?? 1,
      speedMultiplier: level.speedMultiplier ?? 1,
      gravityMultiplier: level.gravityMultiplier ?? 1,
      maxActiveOrbs: level.maxActiveOrbs ?? 20,
      level: level.level,
      levelName: level.name,
    }
  }

  getState(score) {
    const current = this.getCurrentLevel()
    const next = this.levels[this.currentIndex + 1] ?? null
    const from = current.minScore
    const to = next?.minScore ?? from + 1000
    const progress = to > from ? Math.min(1, Math.max(0, (score - from) / (to - from))) : 1

    return {
      level: current.level,
      name: current.name,
      minScore: from,
      nextMinScore: next?.minScore ?? null,
      progress,
      unlockedTypes: [...current.unlocks],
      isMaxLevel: !next,
    }
  }
}

export default LevelSystem
