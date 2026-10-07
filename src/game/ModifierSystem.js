/**
 * ModifierSystem — Rotating daily modifiers + limited-time event match modes
 *
 * Daily modifiers rotate automatically based on the current UTC day.
 * Event modes can be enabled via setEventMode(id) from the server config
 * or an admin endpoint — no code changes needed to activate one.
 *
 * Modifiers are ADDITIVE on top of the existing game systems. They multiply
 * relevant parameters (spawn rates, speeds, coin rewards, etc.) without
 * touching the underlying logic.
 */

// ── Daily rotating modifiers ──────────────────────────────────────────────────
// Rotate through these each UTC day. Add new entries to expand the pool.
const DAILY_MODIFIERS = [
  {
    id:   'vanilla',
    label: null,                       // null = no banner shown
    desc: 'Standard rules',
    orbSpawnMult:    1.0,
    hazardSpeedMult: 1.0,
    coinMult:        1.0,
    windMult:        1.0,
    cooldownMult:    1.0,
  },
  {
    id:   'orb_surge',
    label: '⚡ Orb Surge',
    desc: 'Increased orb spawn rate',
    orbSpawnMult:    1.5,
    hazardSpeedMult: 1.0,
    coinMult:        1.0,
    windMult:        1.0,
    cooldownMult:    1.0,
  },
  {
    id:   'speed_demon',
    label: '🌪️ Speed Demon',
    desc: 'Faster hazards',
    orbSpawnMult:    1.0,
    hazardSpeedMult: 1.4,
    coinMult:        1.0,
    windMult:        1.0,
    cooldownMult:    1.0,
  },
  {
    id:   'coin_rush',
    label: '🪙 Coin Rush',
    desc: 'Double Lava Coin rewards',
    orbSpawnMult:    1.0,
    hazardSpeedMult: 1.0,
    coinMult:        2.0,
    windMult:        1.0,
    cooldownMult:    1.0,
  },
  {
    id:   'gale_force',
    label: '🌬️ Gale Force',
    desc: 'Stronger wind zones',
    orbSpawnMult:    1.0,
    hazardSpeedMult: 1.0,
    coinMult:        1.0,
    windMult:        2.0,
    cooldownMult:    1.0,
  },
  {
    id:   'quick_hands',
    label: '⚡ Quick Hands',
    desc: 'Reduced cooldowns',
    orbSpawnMult:    1.2,
    hazardSpeedMult: 1.0,
    coinMult:        1.0,
    windMult:        1.0,
    cooldownMult:    0.5,
  },
]

// ── Limited-time event match modes ────────────────────────────────────────────
// Enable via setEventMode('volcano_meltdown') etc. from server config / admin.
export const EVENT_MODES = {
  volcano_meltdown: {
    id:    'volcano_meltdown',
    label: '🌋 Volcano Meltdown',
    desc:  'Constant environmental hazards and eruptions',
    orbSpawnMult:       0.7,
    hazardSpeedMult:    2.0,
    eventIntervalMult:  0.4,  // world events fire much more frequently
    coinMult:           1.5,
    windMult:           1.5,
    jackpotWeightMult:  1.0,
    bossIntervalMs:     null,
    orbMaxMult:         1.0,
  },
  jackpot_frenzy: {
    id:    'jackpot_frenzy',
    label: '💰 Jackpot Frenzy',
    desc:  'Increased Jackpot Orb spawn rate',
    orbSpawnMult:       1.2,
    hazardSpeedMult:    1.0,
    eventIntervalMult:  1.0,
    coinMult:           3.0,
    windMult:           1.0,
    jackpotWeightMult:  5.0,  // jackpot orbs are 5× more likely
    bossIntervalMs:     null,
    orbMaxMult:         1.0,
  },
  boss_rush: {
    id:    'boss_rush',
    label: '👾 Boss Rush',
    desc:  'Multiple boss encounters in a single run',
    orbSpawnMult:       1.0,
    hazardSpeedMult:    1.2,
    eventIntervalMult:  0.8,
    coinMult:           1.5,
    windMult:           1.0,
    jackpotWeightMult:  1.0,
    bossIntervalMs:     20000,  // bosses every 20 seconds
    orbMaxMult:         1.0,
  },
  orb_flood: {
    id:    'orb_flood',
    label: '🌊 Orb Flood',
    desc:  'Large numbers of orbs spawn continuously',
    orbSpawnMult:       3.0,
    hazardSpeedMult:    1.0,
    eventIntervalMult:  1.0,
    coinMult:           1.0,
    windMult:           1.0,
    jackpotWeightMult:  1.0,
    bossIntervalMs:     null,
    orbMaxMult:         2.0,  // double max active orbs
  },
}

export class ModifierSystem {
  constructor() {
    this._eventMode = null          // active event mode id (or null)
    this._dailyMod  = this._getDailyModifier()
  }

  /** Override — call from server config / admin endpoint to enable an event mode */
  setEventMode(modeId) {
    if (modeId === null || modeId === 'none') {
      this._eventMode = null
      return
    }
    if (!EVENT_MODES[modeId]) {
      console.warn(`[ModifierSystem] Unknown event mode: ${modeId}`)
      return
    }
    this._eventMode = modeId
  }

  getEventMode() { return this._eventMode }

  /** Called once per tick to refresh the daily modifier (in case day rolled over) */
  update() {
    this._dailyMod = this._getDailyModifier()
  }

  /**
   * Returns the combined effective multipliers for the current session.
   * All values are multiplicative: 1.0 = no change, 2.0 = double, etc.
   */
  getModifiers() {
    const d = this._dailyMod
    const e = this._eventMode ? EVENT_MODES[this._eventMode] : {}

    return {
      orbSpawnMult:      (d.orbSpawnMult      ?? 1) * (e.orbSpawnMult      ?? 1),
      hazardSpeedMult:   (d.hazardSpeedMult   ?? 1) * (e.hazardSpeedMult   ?? 1),
      eventIntervalMult: (e.eventIntervalMult ?? 1),                               // only from event mode
      coinMult:          (d.coinMult          ?? 1) * (e.coinMult          ?? 1),
      windMult:          (d.windMult          ?? 1) * (e.windMult          ?? 1),
      cooldownMult:      (d.cooldownMult      ?? 1),                               // only from daily
      jackpotWeightMult: (e.jackpotWeightMult ?? 1),                               // only from event mode
      bossIntervalMs:    e.bossIntervalMs     ?? null,
      orbMaxMult:        (e.orbMaxMult        ?? 1),
    }
  }

  /** Compact state sent to the client each tick (shown in HazardBanner) */
  getClientState() {
    const d = this._dailyMod
    const e = this._eventMode ? EVENT_MODES[this._eventMode] : null
    return {
      dailyModifierId:    d.id,
      dailyModifierLabel: d.label,
      eventModeId:        this._eventMode ?? null,
      eventModeLabel:     e?.label ?? null,
      // Display at most one label in the banner — event mode takes priority
      activeLabel:        e?.label ?? d.label ?? null,
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _getDailyModifier() {
    // Rotate by UTC day number (changes at midnight UTC)
    const day = Math.floor(Date.now() / 86_400_000)
    return DAILY_MODIFIERS[day % DAILY_MODIFIERS.length]
  }
}

export default ModifierSystem
