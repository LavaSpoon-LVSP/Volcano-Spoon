/**
 * ARENA SYSTEM — Volcano Spoon
 *
 * World Event System (additive — all original logic preserved):
 *   Automatic hazards fire on a scaling timer based on survival time.
 *   Events: earthquake | lava_rain | darkness | wind_zone |
 *           lava_walls | orb_storm | eruption_burst
 *
 * Boss phases trigger automatically at survival milestones:
 *   Phase 1 @ 60s  — Volcanic Eruption
 *   Phase 2 @ 120s — Orb Storm
 *   Phase 3 @ 240s — Survival Challenge
 *   (Volcano Monster phase removed)
 *   + Legacy repeat cycle continues past 240s
 *
 * Emits event objects — caller (GameLogic) applies them to physics / OrbSystem / effects.
 */
import {
  ARENA_EVENT_INTERVAL_MS, ARENA_LAVA_RAIN_COUNT,
  ARENA_EARTHQUAKE_SHAKE, ARENA_EARTHQUAKE_MS,
  ARENA_DARKNESS_ALPHA, ARENA_DARKNESS_MS,
  ARENA_WIND_FORCE, ARENA_WIND_MS,
  BOSS_TRIGGER_SURVIVAL_MS, BOSS_REPEAT_INTERVAL_MS,
  BOSS_ORB_STORM_COUNT, BOSS_ERUPTION_WAVES,
  BOSS_WAVE_INTERVAL_MS, BOSS_SURVIVAL_DURATION_MS,
  // World Event System constants
  LAVA_RAIN_WARNING_MS,
  LAVA_RAIN_DROP_COUNT,
  LAVA_WALL_SPEED, LAVA_WALL_WIDTH, LAVA_WALL_DURATION_MS,
  ORB_STORM_POSITIVE_COUNT, ORB_STORM_NEGATIVE_COUNT,
  WORLD_EVENT_MIN_INTERVAL_MS,
  GAME_WIDTH, ZONE_LEFT, ZONE_RIGHT, CEILING_Y, FLOOR_Y,
  // Wall Spikes / Ninja Knives — ported from the backend, never wired up on
  // this engine before (see _spawnWallSpikes / _spawnNinjaKnives below).
  WALL_SPIKES_COUNT, WALL_SPIKES_LENGTH, WALL_SPIKES_THICKNESS,
  WALL_SPIKES_CYCLE_MS, WALL_SPIKES_DURATION_MS, WALL_SPIKES_WARNING_MS,
  NINJA_KNIFE_SPEED, NINJA_KNIFE_RADIUS, NINJA_KNIFE_WARNING_MS,
  NINJA_KNIFE_VOLLEY_MIN, NINJA_KNIFE_VOLLEY_MAX, NINJA_KNIFE_VOLLEY_STAGGER_MS,
  NINJA_KNIFE_BANDS,
  WALL_SPIKES_INTERVAL_MS, WALL_SPIKES_MIN_INTERVAL_MS,
  NINJA_KNIFE_INTERVAL_MS, NINJA_KNIFE_MIN_INTERVAL_MS,
} from './constants.js'
import { random } from './seededRandom.js'
import { now as simTime } from './simClock.js'
import { getStageProfile } from './arenaStages.js'

const rand = (min, max) => random() * (max - min) + min

// No world events or boss phases for the first 20s of survival time.
const HAZARD_GRACE_MS = 20000

let _wallId = 5000
let _dropId = 6000
let _spikeId = 7000
let _knifeId = 8000
const nextWallId = () => _wallId++
const nextDropId = () => _dropId++
const nextSpikeId = () => _spikeId++
const nextKnifeId = () => _knifeId++

// Full event rotation pool — the "big" world events. Which of these a given
// run may actually draw from is narrowed further by this.stageProfile.
// allowedWorldEvents (earthquake/darkness are hard-gated to Stage 5+/6+ —
// see arenaStages.js). Wall spikes / ninja knives are NOT in this pool —
// they're the arena's "always-present, learn-them-early" hazards and run on
// their own independent, gentler-at-Stage-1 cadence (see
// _spawnWallSpikes/_spawnNinjaKnives's callers in update() below).
const WORLD_EVENTS = [
  'earthquake',
  'lava_rain',
  'darkness',
  'wind_zone',
  'lava_walls',
  'orb_storm',
  'eruption_burst',
]

// Boss phases: [survivalMs threshold, label]
// Thresholds pulled in from 60s/120s/240s — the volcanic eruption in
// particular ("all the orbs erupt from the top") took a full minute of
// clean survival to ever see, which read as "hazards barely happen".
const BOSS_PHASES = [
  { ms: 35000,  label: 'VOLCANIC ERUPTION!',  type: 'eruption'  },
  { ms: 90000,  label: 'ORB STORM!',           type: 'orb_storm' },
  { ms: 180000, label: 'SURVIVE!',             type: 'survival'  },
]

export class ArenaSystem {
  constructor() {
    // Persistent Arena Stage profile (NOT reset by reset() — a per-run
    // reset — since Arena Stage persists across runs, same as OrbSystem's
    // arenaStage). Drives which hazards this arena may run and how often —
    // see arenaStages.js and setStageProfile below.
    this.stageProfile = getStageProfile(1)
    this.reset()
  }

  /** Called whenever the player's (persistent) Arena Stage changes. */
  setStageProfile(stage) {
    this.stageProfile = getStageProfile(stage)
  }

  reset() {
    this.sessionStartMs      = simTime()

    // ── Event timing ──────────────────────────────────────────────────
    // NOTE: seeded to sessionStartMs (not 0) — `now` is an absolute
    // simTime() timestamp, so `now - 0` would already exceed any interval
    // on the very first update() call and fire a hazard instantly.
    this.lastEventMs         = this.sessionStartMs
    this.lastArenaEventMs    = this.sessionStartMs   // legacy alias kept for compat
    // Independent wall-spike / ninja-knife cadence (see arenaStages.js's
    // STAGE_LIGHT_HAZARD_FREQUENCY) — separate timers from the big world
    // events above.
    this.lastSpikeMs         = this.sessionStartMs
    this.lastKnifeMs         = this.sessionStartMs

    // ── Darkness ──────────────────────────────────────────────────────
    this.darknessAlpha       = 0
    this.darknessUntil       = 0

    // ── Earthquake ────────────────────────────────────────────────────
    this.earthquakeActive    = false
    this.earthquakeUntil     = 0
    this.earthquakeShake     = 0

    // ── Wind ──────────────────────────────────────────────────────────
    this.windActive          = false
    this.windForce           = 0
    this.windUntil           = 0

    // ── Orb storm ─────────────────────────────────────────────────────
    this.orbStormActive      = false
    this.orbStormUntil       = 0

    // ── Moving lava walls ─────────────────────────────────────────────
    this.lavaWalls           = []

    // ── Lava rain drops ───────────────────────────────────────────────
    this.lavaRainDrops       = []

    // ── Wall spikes / Ninja knives (ported from backend) ────────────────
    this.wallSpikes           = []
    this.ninjaKnives          = []

    // ── Eruption waves (legacy + boss) ────────────────────────────────
    this.eruptionWavesLeft   = 0
    this.nextWaveMs          = 0

    // ── Survival phase ────────────────────────────────────────────────
    this.survivalPhaseActive    = false
    this.survivalPhaseUntil     = 0
    this.survivalPhaseRewarded  = false

    // ── Boss phases ───────────────────────────────────────────────────
    this.bossPhaseIndex      = -1   // -1 = no phase triggered yet
    this.lastBossMs          = 0
    this.bossTriggered       = false  // legacy compat flag
    // A boss phase's threshold can be crossed while another hazard is still
    // running — rather than stacking on top of it (violates "only one
    // hazard at a time"), the phase's actual effects are queued here and
    // fire on the first update() tick once the arena is clear.
    this._pendingBossPhaseIdx      = null
    this._pendingLegacyBossEvent   = false

    // ── Active event tracker (prevents same event stacking early game) ─
    this.activeEventTypes    = new Set()
  }

  /**
   * True while any "big" world event or boss-phase effect is still running.
   * Used to enforce "only one hazard active at a time" — a new world event
   * or boss phase won't start until whatever's currently running clears.
   * Wall spikes / ninja knives are deliberately NOT included — they're the
   * arena's always-present ambient obstacle, not a "hazard event" in this
   * sense (see arenaStages.js's STAGE_LIGHT_HAZARD_FREQUENCY notes).
   */
  _hasActiveBigHazard() {
    return (
      this.earthquakeActive ||
      this.darknessAlpha > 0 ||
      this.windActive ||
      this.orbStormActive ||
      this.survivalPhaseActive ||
      this.eruptionWavesLeft > 0 ||
      this.lavaWalls.some(w => w.active) ||
      this.lavaRainDrops.some(d => d.active)
    )
  }

  // ── Main update ─────────────────────────────────────────────────────
  update(now) {
    const events = []
    const survivalMs = now - this.sessionStartMs

    // ── Expire timed states ──────────────────────────────────────────
    if (this.darknessAlpha > 0 && now >= this.darknessUntil) {
      this.darknessAlpha = 0
      this.activeEventTypes.delete('darkness')
    }
    if (this.earthquakeActive && now >= this.earthquakeUntil) {
      this.earthquakeActive = false; this.earthquakeShake = 0
      this.activeEventTypes.delete('earthquake')
    }
    if (this.windActive && now >= this.windUntil) {
      this.windActive = false; this.windForce = 0
      this.activeEventTypes.delete('wind_zone')
    }
    if (this.orbStormActive && now >= this.orbStormUntil) {
      this.orbStormActive = false
      this.activeEventTypes.delete('orb_storm')
    }

    // ── Eruption waves ────────────────────────────────────────────────
    if (this.eruptionWavesLeft > 0 && now >= this.nextWaveMs) {
      this.eruptionWavesLeft--
      this.nextWaveMs = now + BOSS_WAVE_INTERVAL_MS
      events.push({ type: 'orb_wave', count: 18 })
    }

    // ── Survival phase completion ─────────────────────────────────────
    if (this.survivalPhaseActive && !this.survivalPhaseRewarded && now >= this.survivalPhaseUntil) {
      this.survivalPhaseActive   = false
      this.survivalPhaseRewarded = true
      events.push({ type: 'survival_phase_complete', bonus: 200 })
    }

    // ── Update moving lava walls (advance positions each frame) ───────
    this._updateLavaWalls()

    // ── Update lava rain drops (emit hit events when drop lands) ──────
    this._updateLavaRainDrops(now).forEach(hit => events.push(hit))

    // ── Update wall spikes / ninja knives ──────────────────────────────
    this._updateWallSpikes(now)
    this._updateNinjaKnives(now)

    // ── World event rotation (time-scaled interval, Arena-Stage gated) ──
    // No hazards for the first HAZARD_GRACE_MS of a run — gives the player
    // a clean start before earthquakes/lava rain/darkness/etc. can trigger.
    if (survivalMs >= HAZARD_GRACE_MS) {
      // Arena Stage's hazardFrequencyMultiplier scales how often the big
      // world events fire — Stage 1 is 0.70x (calmer), Stage 8 is 2.40x.
      // Only ONE big hazard runs at a time: a new one won't start until
      // whatever's currently active (earthquake, wind, darkness, lava
      // walls/rain, orb storm, survival phase, eruption waves) has cleared —
      // see _hasActiveBigHazard(). lastEventMs is only advanced when an
      // event actually fires, so a busy arena just tries again next tick
      // instead of silently losing that hazard's turn.
      const interval = this._getEventInterval(survivalMs) / (this.stageProfile.hazardFrequencyMultiplier || 1)
      if (!this._hasActiveBigHazard() && now - this.lastEventMs > interval) {
        this.lastEventMs = now
        this.lastArenaEventMs = now  // keep legacy alias in sync
        const evt = this._triggerWorldEvent(now, survivalMs)
        if (evt) events.push(evt)
      }

      // ── Wall spikes / ninja knives — independent, always-present-from-
      // Stage-1 cadence (see arenaStages.js's STAGE_LIGHT_HAZARD_FREQUENCY).
      const spikeInterval = Math.max(
        WALL_SPIKES_MIN_INTERVAL_MS,
        WALL_SPIKES_INTERVAL_MS / (this.stageProfile.lightHazardFrequencyMultiplier || 1),
      )
      if (!this.wallSpikes.some(s => s.active) && now - this.lastSpikeMs > spikeInterval) {
        this.lastSpikeMs = now
        const count = this._spawnWallSpikes(this._getDiffScale(survivalMs))
        if (count) events.push({ type: 'wall_spikes_spawned', count })
      }
      const knifeInterval = Math.max(
        NINJA_KNIFE_MIN_INTERVAL_MS,
        NINJA_KNIFE_INTERVAL_MS / (this.stageProfile.lightHazardFrequencyMultiplier || 1),
      )
      if (now - this.lastKnifeMs > knifeInterval) {
        this.lastKnifeMs = now
        const count = this._spawnNinjaKnives(this._getDiffScale(survivalMs))
        if (count) events.push({ type: 'ninja_knives_spawned', count })
      }

      // ── Boss phases ─────────────────────────────────────────────────
      this._updateBossPhases(now, survivalMs).forEach(e => events.push(e))
    }

    return events
  }

  // ── Visual state for renderer ────────────────────────────────────────
  getVisualState() {
    const now = simTime()
    return {
      // Existing (renderer reads these)
      darknessAlpha:    this.darknessAlpha,
      earthquakeActive: this.earthquakeActive,
      earthquakeShake:  this.earthquakeShake,
      // New — .map(o => ({...o})) (not just .filter()) so the renderer gets
      // its OWN copy of each hazard object, never the live one collision
      // checks (GameLogic._checkWallSpikeCollisions etc.) read from
      // this.wallSpikes/lavaWalls/ninjaKnives directly. .filter() alone
      // still hands out the SAME object references — anything with a
      // handle on this returned state (a rendering bug, or a console
      // reaching in through React's component state) could flip e.g.
      // `.active = false` on a spike and disable that hazard mid-run. A
      // copy can be poked at harmlessly; it can never reach back into the
      // real hazard driving collisions.
      lavaWalls:        this.lavaWalls.filter(w => w.active).map(w => ({ ...w })),
      lavaRainDrops:    this.lavaRainDrops.filter(d => d.active).map(d => ({ ...d })),
      windActive:       this.windActive,
      windForce:        this.windForce,
      orbStormActive:   this.orbStormActive,
      bossPhaseIndex:   this.bossPhaseIndex,
      // HUD timer support: remaining ms for each active event
      windRemainingMs:        this.windActive          ? Math.max(0, this.windUntil        - now) : 0,
      darknessRemainingMs:    this.darknessAlpha > 0   ? Math.max(0, this.darknessUntil    - now) : 0,
      earthquakeRemainingMs:  this.earthquakeActive    ? Math.max(0, this.earthquakeUntil  - now) : 0,
      orbStormRemainingMs:    this.orbStormActive      ? Math.max(0, this.orbStormUntil    - now) : 0,
      lavaWallsActive:        this.lavaWalls.some(w => w.active),
      lavaRainActive:         this.lavaRainDrops.some(d => d.active),
      // Wall spikes / ninja knives — GameEngine already had #drawWallSpikes/
      // #drawNinjaKnives ready and waiting on these exact field names; they
      // just never had anything to draw because nothing spawned them.
      wallSpikes:             this.wallSpikes.filter(s => s.active).map(s => ({ ...s })),
      ninjaKnives:            this.ninjaKnives.filter(k => k.active).map(k => ({ ...k })),
      wallSpikesActive:       this.wallSpikes.some(s => s.active),
      ninjaKnivesActive:      this.ninjaKnives.some(k => k.active),
      // Boss-phase 2 ("Survival Challenge") — badge fix needs this so it can
      // hide the pill the instant the phase actually ends, instead of
      // trusting the never-reset bossPhaseIndex ratchet.
      survivalPhaseActive:      this.survivalPhaseActive,
      survivalPhaseRemainingMs: this.survivalPhaseActive ? Math.max(0, this.survivalPhaseUntil - now) : 0,
    }
  }

  // ── Scaling helpers ──────────────────────────────────────────────────

  /** Event interval shrinks from 25s → 8s over the first 3 minutes */
  _getEventInterval(survivalMs) {
    const t = Math.min(survivalMs / 180000, 1)
    return ARENA_EVENT_INTERVAL_MS - (ARENA_EVENT_INTERVAL_MS - WORLD_EVENT_MIN_INTERVAL_MS) * t
  }

  /** Difficulty scale: 1.0 at start → 3.0 at 4+ minutes */
  _getDiffScale(survivalMs) {
    return Math.min(1 + survivalMs / 120000, 3.0)
  }

  // ── World event dispatcher ──────────────────────────────────────────

  _triggerWorldEvent(now, survivalMs) {
    const scale = this._getDiffScale(survivalMs)

    // Caller (update()) only invokes this when _hasActiveBigHazard() is
    // false, so "only one hazard at a time" is already guaranteed — this
    // filter just picks from what this Arena Stage allows. Earthquake/
    // darkness are hard-gated to Stage 5+/6+ (see arenaStages.js), so a
    // Stage 1 player can never get hit by either.
    const available = WORLD_EVENTS.filter(t => this.stageProfile.allowedWorldEvents.includes(t))
    if (!available.length) return null

    const type = available[Math.floor(random() * available.length)]
    this.activeEventTypes.add(type)

    switch (type) {
      case 'earthquake': {
        const duration = ARENA_EARTHQUAKE_MS * Math.min(scale, 1.5)
        const shake    = ARENA_EARTHQUAKE_SHAKE * Math.min(scale, 1.8)
        this.earthquakeActive = true
        this.earthquakeUntil  = now + duration
        this.earthquakeShake  = shake
        return { type: 'earthquake', duration, shake }
      }

      case 'lava_rain': {
        const count = Math.ceil(ARENA_LAVA_RAIN_COUNT * Math.min(scale, 2.5))
        this._spawnLavaRainDrops(now, count)
        return { type: 'lava_rain', count }
      }

      case 'darkness': {
        this.darknessAlpha = ARENA_DARKNESS_ALPHA
        this.darknessUntil = now + ARENA_DARKNESS_MS
        return { type: 'darkness', alpha: ARENA_DARKNESS_ALPHA, duration: ARENA_DARKNESS_MS }
      }

      case 'wind_zone': {
        const force = (random() < 0.5 ? 1 : -1) * ARENA_WIND_FORCE * Math.min(scale, 1.5)
        this.windActive = true
        this.windForce  = force
        this.windUntil  = now + ARENA_WIND_MS
        return { type: 'wind', force, duration: ARENA_WIND_MS }
      }

      case 'lava_walls': {
        this._spawnLavaWalls(scale)
        return { type: 'lava_walls_spawned' }
      }

      case 'orb_storm': {
        const pos = Math.ceil(ORB_STORM_POSITIVE_COUNT * Math.min(scale, 2))
        const neg = Math.ceil(ORB_STORM_NEGATIVE_COUNT * Math.min(scale, 2))
        this.orbStormActive = true
        this.orbStormUntil  = now + 8000
        return { type: 'orb_storm', positiveCount: pos, negativeCount: neg }
      }

      case 'eruption_burst': {
        const count = Math.ceil(6 * Math.min(scale, 2.5))
        return { type: 'orb_wave', count }
      }

      // NOTE: wall_spikes / ninja_knives used to be cases here too, but
      // they're no longer part of this rotation pool — they run on their
      // own independent, Stage-1-present cadence (see update() above).

      default: return null
    }
  }

  // ── Moving lava walls ────────────────────────────────────────────────

  _spawnLavaWalls(scale = 1) {
    // Was up to 2 walls at once past scale 2 — with each wall picking its
    // own random gapY independently, two walls in flight could easily leave
    // no y-position that's safe for BOTH at once ("too close" / no real
    // gap). One wall at a time keeps there always being a clean path.
    const wallCount = 1
    for (let i = 0; i < wallCount; i++) {
      const fromLeft  = random() < 0.5
      // Gap the player can fly through — narrows with difficulty, but never
      // below a floor generous enough to comfortably fit through (was 80,
      // read as "too close"/unfair at high difficulty).
      const gapHeight = Math.max(140, 220 - scale * 20)
      const gapY      = rand(CEILING_Y + 30, FLOOR_Y - 30 - gapHeight)

      this.lavaWalls.push({
        id:        nextWallId(),
        x:         fromLeft ? ZONE_LEFT - LAVA_WALL_WIDTH : ZONE_RIGHT + LAVA_WALL_WIDTH,
        direction: fromLeft ? 1 : -1,
        speed:     LAVA_WALL_SPEED * Math.min(scale, 2),
        width:     LAVA_WALL_WIDTH,
        gapY,
        gapHeight,
        active:    true,
        spawnedAt: simTime(),
      })
    }
  }

  _updateLavaWalls() {
    this.lavaWalls = this.lavaWalls.filter(wall => {
      if (!wall.active) return false
      wall.x += wall.direction * wall.speed
      // Expire once it exits the opposite side
      if (wall.direction > 0 && wall.x > ZONE_RIGHT + LAVA_WALL_WIDTH + 30) wall.active = false
      if (wall.direction < 0 && wall.x < ZONE_LEFT  - LAVA_WALL_WIDTH - 30) wall.active = false
      return wall.active
    })
  }

  // ── Wall spikes ─────────────────────────────────────────────────────
  // Ported from the backend: spikes mounted on the left/right walls hold
  // retracted for a telegraph window (WALL_SPIKES_WARNING_MS), then
  // continuously ease retracted -> extended -> retracted for
  // WALL_SPIKES_DURATION_MS. GameLogic._checkWallSpikeCollisions
  // independently re-derives the same extension value GameEngine's
  // #drawWallSpikes uses, so the hitbox always matches what's drawn.
  _spawnWallSpikes(scale = 1) {
    const now = simTime()
    const countMult = this.stageProfile.lightHazardCountMultiplier ?? 1
    const count = Math.max(1, Math.ceil(WALL_SPIKES_COUNT * Math.min(scale, 2) * countMult))
    const warningUntil = now + WALL_SPIKES_WARNING_MS
    const until = warningUntil + WALL_SPIKES_DURATION_MS
    const cycleMs = WALL_SPIKES_CYCLE_MS / Math.min(1 + (scale - 1) * 0.3, 1.6)

    // Spread spikes evenly down the wall (with a little jitter inside each
    // slot) instead of pure random y, so they don't clump and leave a big
    // dead stretch with no threat at all.
    const top    = CEILING_Y + 50
    const bottom = FLOOR_Y - 50
    const slotH  = (bottom - top) / count

    for (const side of ['left', 'right']) {
      for (let i = 0; i < count; i++) {
        const slotTop = top + slotH * i
        this.wallSpikes.push({
          id:            nextSpikeId(),
          side,
          y:             rand(slotTop + slotH * 0.2, slotTop + slotH * 0.8),
          length:        WALL_SPIKES_LENGTH,
          thickness:     WALL_SPIKES_THICKNESS,
          cycleMs,
          // Capped to the first half of the cycle so every spike is already
          // on its way OUT the instant the telegraph ends.
          phaseOffsetMs: rand(0, cycleMs * 0.5),
          spawnedAt:     now,
          warningUntil,
          until,
          active:        true,
        })
      }
    }
    return count * 2
  }

  _updateWallSpikes(now) {
    this.wallSpikes = this.wallSpikes.filter((s) => {
      if (!s.active) return false
      if (now >= s.until) s.active = false
      return s.active
    })
  }

  // ── Ninja knives ─────────────────────────────────────────────────────
  // A thrown knife telegraphs for NINJA_KNIFE_WARNING_MS (held off-screen,
  // can't collide), then flies in a straight line to the far side, where it
  // expires. GameLogic._checkNinjaKnifeCollisions is a simple circle-circle
  // check that independently re-checks warningUntil so a knife can never
  // hurt during its telegraph.
  _spawnNinjaKnives(scale = 1) {
    const now = simTime()
    const countMult = this.stageProfile.lightHazardCountMultiplier ?? 1
    const raw = (NINJA_KNIFE_VOLLEY_MIN + (Math.max(1, scale) - 1) * 0.6) * countMult
    let count = Math.floor(raw)
    if (random() < raw - count) count += 1
    count = Math.max(1, Math.min(count, NINJA_KNIFE_VOLLEY_MAX))

    // Distinct height bands, shuffled, so a volley reads as "one high, one
    // low" rather than a stack of knives at the same height.
    const span  = FLOOR_Y - CEILING_Y
    const bands = NINJA_KNIFE_BANDS.slice().sort(() => random() - 0.5)

    for (let i = 0; i < count; i++) {
      const [lo, hi] = bands[i % bands.length]
      const y        = CEILING_Y + span * rand(lo, hi)
      const fromLeft = random() < 0.5
      const speed    = NINJA_KNIFE_SPEED * rand(0.85, 1.25) * Math.min(scale, 1.8)

      this.ninjaKnives.push({
        id:           nextKnifeId(),
        x:            fromLeft ? ZONE_LEFT - NINJA_KNIFE_RADIUS - 10 : ZONE_RIGHT + NINJA_KNIFE_RADIUS + 10,
        y,
        vx:           fromLeft ? speed : -speed,
        radius:       NINJA_KNIFE_RADIUS,
        spawnedAt:    now,
        // Small stagger inside a volley so they land together, not a trickle.
        warningUntil: now + NINJA_KNIFE_WARNING_MS + i * NINJA_KNIFE_VOLLEY_STAGGER_MS,
        active:       true,
      })
    }
    return count
  }

  _updateNinjaKnives(now) {
    this.ninjaKnives = this.ninjaKnives.filter((k) => {
      if (!k.active) return false
      if (now < k.warningUntil) return true // still telegraphing — hold position
      k.x += k.vx
      if (k.vx > 0 && k.x > ZONE_RIGHT + k.radius + 20) k.active = false
      if (k.vx < 0 && k.x < ZONE_LEFT  - k.radius - 20) k.active = false
      return k.active
    })
  }

  // ── Lava rain drops ──────────────────────────────────────────────────

  _spawnLavaRainDrops(now, count) {
    for (let i = 0; i < count; i++) {
      const x = rand(ZONE_LEFT + 20, ZONE_RIGHT - 20)
      this.lavaRainDrops.push({
        id:          nextDropId(),
        x,
        warningUntil: now + LAVA_RAIN_WARNING_MS,
        fallUntil:    now + LAVA_RAIN_WARNING_MS + 550,
        hitUntil:     now + LAVA_RAIN_WARNING_MS + 750,
        active:       true,
        hitEmitted:   false,
      })
    }
  }

  _updateLavaRainDrops(now) {
    const hits = []
    this.lavaRainDrops = this.lavaRainDrops.filter(drop => {
      if (!drop.active) return false
      if (!drop.hitEmitted && now >= drop.fallUntil) {
        drop.hitEmitted = true
        hits.push({ type: 'lava_rain_hit', x: drop.x, id: drop.id })
      }
      if (now >= drop.hitUntil) drop.active = false
      return drop.active
    })
    return hits
  }

  // ── Boss phases ──────────────────────────────────────────────────────

  _updateBossPhases(now, survivalMs) {
    const events = []

    // Resolve anything queued because the arena was busy with another
    // hazard when its threshold was first crossed — fires the moment
    // _hasActiveBigHazard() clears, same "one hazard at a time" rule as
    // the regular world-event rotation.
    if (this._pendingBossPhaseIdx != null && !this._hasActiveBigHazard()) {
      const idx = this._pendingBossPhaseIdx
      this._pendingBossPhaseIdx = null
      this.bossPhaseIndex = idx
      this.lastBossMs     = now
      this.bossTriggered  = true
      const evt = this._triggerBossPhase(now, idx)
      if (evt) events.push(evt)
    } else if (this._pendingLegacyBossEvent && !this._hasActiveBigHazard()) {
      this._pendingLegacyBossEvent = false
      this.lastBossMs = now
      const evt = this._triggerLegacyBossEvent(now)
      if (evt) events.push(evt)
    }

    // Advance to next boss phase when survival threshold is crossed — if
    // another hazard is already running, queue it instead of stacking two
    // hazards at once (resolved above on a later tick).
    const nextIdx = this.bossPhaseIndex + 1
    if (this._pendingBossPhaseIdx == null && nextIdx < BOSS_PHASES.length && survivalMs >= BOSS_PHASES[nextIdx].ms) {
      if (this._hasActiveBigHazard()) {
        this._pendingBossPhaseIdx = nextIdx
      } else {
        this.bossPhaseIndex = nextIdx
        this.lastBossMs     = now
        this.bossTriggered  = true
        const evt = this._triggerBossPhase(now, nextIdx)
        if (evt) events.push(evt)
      }
    }

    // Legacy repeat cycle after all phases have fired (every BOSS_REPEAT_INTERVAL_MS)
    if (!this._pendingLegacyBossEvent && this.bossPhaseIndex >= BOSS_PHASES.length - 1) {
      if ((now - this.lastBossMs) >= BOSS_REPEAT_INTERVAL_MS) {
        if (this._hasActiveBigHazard()) {
          this._pendingLegacyBossEvent = true
        } else {
          this.lastBossMs = now
          const evt = this._triggerLegacyBossEvent(now)
          if (evt) events.push(evt)
        }
      }
    }

    return events
  }

  _triggerBossPhase(now, phaseIdx) {
    const phase = BOSS_PHASES[phaseIdx]
    switch (phase.type) {

      case 'eruption': {
        // Phase 1: Volcanic Eruption — eruption waves only. Used to also
        // switch on an earthquake + lava rain at the same moment, which is
        // exactly the "more than one hazard at once" the player doesn't
        // want — the boss pill itself is the hazard here.
        const waves = BOSS_ERUPTION_WAVES + 3
        this.eruptionWavesLeft = waves
        this.nextWaveMs        = now + 800
        return {
          type:  'boss_eruption_start',
          waves,
          phase: 1,
          label: phase.label,
        }
      }

      case 'orb_storm': {
        // Phase 2: Orb Storm — massive positive + negative orb wave
        this.orbStormActive = true
        this.orbStormUntil  = now + 12000
        return {
          type:          'boss_orb_storm',
          count:         BOSS_ORB_STORM_COUNT * 3,
          phase:         2,
          label:         phase.label,
        }
      }

      case 'survival': {
        // Phase 3: Survival Challenge — the timer itself is the hazard.
        // Used to also switch on lava walls + darkness + earthquake + lava
        // rain in the same instant ("everything at once"), which is the
        // "more than one hazard at a time" problem — four extra hazard
        // pills stacked on top of the boss badge. The light hazards (wall
        // spikes / ninja knives) keep running on their own independent
        // schedule underneath, so this phase still reads as tense without
        // stacking multiple big hazards.
        const duration = BOSS_SURVIVAL_DURATION_MS * 1.5
        this.survivalPhaseActive   = true
        this.survivalPhaseUntil    = now + duration
        this.survivalPhaseRewarded = false
        return {
          type:     'boss_survival_phase',
          duration,
          phase:    3,
          label:    phase.label,
        }
      }

      default: return null
    }
  }

  /** Legacy random boss event — fires after all boss phases have been completed */
  _triggerLegacyBossEvent(now) {
    const BOSS_EVENTS = ['orb_storm', 'eruption_waves', 'survival_phase']
    const type = BOSS_EVENTS[Math.floor(random() * BOSS_EVENTS.length)]
    switch (type) {
      case 'orb_storm':
        return { type: 'boss_orb_storm', count: BOSS_ORB_STORM_COUNT }
      case 'eruption_waves':
        this.eruptionWavesLeft = BOSS_ERUPTION_WAVES; this.nextWaveMs = now + 800
        return { type: 'boss_eruption_start', waves: BOSS_ERUPTION_WAVES }
      case 'survival_phase':
        this.survivalPhaseActive = true; this.survivalPhaseUntil = now + BOSS_SURVIVAL_DURATION_MS; this.survivalPhaseRewarded = false
        return { type: 'boss_survival_phase', duration: BOSS_SURVIVAL_DURATION_MS }
      default: return null
    }
  }
}

export default ArenaSystem
