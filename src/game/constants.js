
export const GRAVITY           = 0.20     // px/frame² - was 0.01 (imperceptible/"no gravity"), then 0.5 (matched backend but felt too strong), then 0.28 (still felt too heavy per playtest) — lowered again for a floatier fall
export const MAX_FALL_SPEED    = 14          // terminal velocity - prevents endless acceleration
export const GRAVITY_SCALE     = 1.0         // multiplier for gravity (tune difficulty)

// LEGACY TAP / FLAP INPUT (kept for reference only — no longer wired up;
// replaced by the drag/swipe vector-launch system below)
export const FLAP_VY           = -11         // upward impulse on tap - responsive but not overpowered
export const FLAP_HORIZONTAL   = 2.0         // subtle horizontal influence when tapping (momentum-based)
export const AIR_CONTROL_POWER = 0.8         // mid-air horizontal influence (NOT instant direction switch)

// NUDGE / STEERING INPUT (legacy — superseded by drag/swipe launch)
export const NUDGE_STRENGTH = 1.8             // horizontal velocity added on tap/nudge
export const NUDGE_ROTATION_AMOUNT = 0.13    // rotation applied when nudging - was 0.08, then 0.16 (a bit too much per playtest), settled slightly lower

// DRAG / SWIPE LAUNCH INPUT — desktop hold-and-drag with the mouse, or a
// mobile swipe, both resolve to a single (dx, dy) vector measured in game-
// space pixels (frontend converts screen px → game px before sending).
// The spoon launches in that vector's direction; drag/swipe distance sets
// the force. Server clamps/derives the final values so a malicious client
// can't send an arbitrarily large force.
// NOTE: these are the baseline (Hard-difficulty) values. Easy/Normal use the
// lighter LAUNCH_MIN_SPEED/LAUNCH_MAX_SPEED overrides inside their
// DIFFICULTY_* preset below — apply those overrides on top of these when a
// non-hard difficulty is active.
export const DRAG_MIN_PX       = 6           // below this distance, ignore (accidental twitch / mis-click)
export const DRAG_MAX_PX       = 100         // drag distance that maps to maximum launch force
export const LAUNCH_MIN_SPEED  = 7           // resultant launch speed at the minimum registered drag - was 6, then 8 (a bit too much per playtest), settled slightly lower
export const LAUNCH_MAX_SPEED  = 11.5        // resultant launch speed at/above DRAG_MAX_PX - was 10, then 13 (a bit too much per playtest), settled slightly lower

// HORIZONTAL MOMENTUM
// Raised to match LAUNCH_MAX_SPEED so a hard horizontal drag/swipe isn't
// clamped weaker than an equally-hard vertical one (the per-frame momentum
// clamp below uses this same ceiling for both axes of a launch).
export const MAX_HORIZONTAL_VEL = 17.0        // max side-to-side speed
export const MOMENTUM_DAMPING   = 0.98       // very slight air damping (arcade feel)
export const MOMENTUM_RECOVERY  = 1.02       // slight acceleration recovery (smooth feel)

// WALL BOUNCE SYSTEM (Most important for arcade feel)
export const WALL_BOUNCE_ENERGY    = 0.40    // 96% energy retained (VERY bouncy - arcade classic)
export const WALL_DAMPING          = 0.02    // tiny damping after bounce
export const WALL_BOUNCE_MIN_VEL   = 1.0     // minimum velocity to register bounce
export const BOUNCE_REFLECTION_SOFTNESS = 0.1 // slight smoothing on reflection angle

// CEILING COLLISION (Prevent camping)
export const CEILING_BOUNCE_ENERGY = 0.34    // was 0.18 (before that 0.07, before that 0.75) - raised again so hitting the roof reads as an actual bounce-back instead of the spoon just sticking/stalling at the ceiling
export const CEILING_EXTRA_GRAVITY = 0.22    // was 1.0 - that value added ~8px/frame of extra downward pull across CEILING_EXTRA_FRAMES, which fully cancelled the bounce-back velocity above and made the ceiling read as "collides only, doesn't bounce". Now just a light nudge so it can't be camped, without erasing the rebound.
export const CEILING_EXTRA_FRAMES  = 4       // frames of extra gravity (was 8 - halved alongside the softer per-frame pull above)

// FLOOR COLLISION
export const FLOOR_KILLS           = true    // floor = instant death (critical core mechanic)

// ============================================================================
// ROTATION & VISUAL FEEDBACK (Game Feel)
// ============================================================================

export const ROTATION_FROM_VELOCITY = 0.11   // visual rotation based on horizontal velocity - was 0.08, then 0.14 (a bit too much per playtest), settled slightly lower
export const ROTATION_FROM_BOUNCE   = 0.4    // strong rotation on wall/ceiling bounce
export const ROTATION_DAMPING       = 0.94   // rotation settles over time
export const ROTATION_MAX           = Math.PI / 1.5 // max rotation angle (not full rotations)

// ============================================================================
// INPUT RESPONSIVENESS
// ============================================================================

export const INPUT_BUFFER_FRAMES = 8         // 133ms @ 60fps - generous input window
export const COYOTE_TIME_FRAMES  = 8         // 133ms @ 60fps - forgiveness window
export const INPUT_QUEUE_SIZE    = 3         // buffer up to 3 inputs
export const FLAP_COOLDOWN_MS = 120
// ============================================================================
// GAME FEEL EFFECT SCALING (Hooks for polish)
// ============================================================================

// Screen Shake (camera feedback)
export const SHAKE_WALL_SCALE      = 2.5     // base shake intensity on wall bounce
export const SHAKE_CEILING_SCALE   = 4.0     // ceiling bounce shakes more
export const SHAKE_VELOCITY_FACTOR = 0.15    // scale shake by impact velocity
export const SHAKE_DAMPING         = 0.90    // shake decays per frame

// Hit Pause (freeze frames for impact feel)
export const HIT_PAUSE_WALL        = 2       // frames frozen on wall (subtle)
export const HIT_PAUSE_CEILING     = 4       // frames frozen on ceiling (more impact)
export const HIT_PAUSE_FLOOR       = 0       // instant death - no pause needed

// Velocity-Based VFX Scaling
export const VFX_TRAIL_INTENSITY   = 0.12    // trail length scales with velocity
export const VFX_PARTICLE_INTENSITY = 0.10   // particle count scales with velocity
export const VFX_GLOW_INTENSITY    = 0.08    // glow size scales with velocity

// Rotation Visual Feedback
export const BOUNCE_ROTATION_SCALE = 0.4     // rotation intensity from impact
export const FLAP_ROTATION_AMOUNT  = 0.18    // rotation on upward input - was 0.12, then 0.22 (a bit too much per playtest), settled slightly lower

// ============================================================================
// MOTION TRAILS & EFFECTS
// ============================================================================

export const TRAIL_LENGTH          = 8       // number of trail points recorded
export const TRAIL_DECAY           = 0.85    // trail opacity decay per point
export const PARTICLE_BURST_COUNT  = 6       // particles per bounce
export const MOTION_BLUR_ENABLED   = true    // calculate for rendering

// ============================================================================
// ORB COLLISION PHYSICS
// A collectible orb gives the spoon a real, one-time collision response the
// instant they touch — before the orb is collected exactly as before. The
// spoon's velocity component heading INTO the orb is reflected back out
// (like bouncing off a small body), plus a guaranteed small outward push so
// every touch visibly redirects the spoon, even a glancing one. Purely a
// one-frame velocity change on top of the existing physics state — no new
// mechanic, no sustained force.
// Values below were tuned down from their originals (restitution 0.4 -> 0.22,
// push 0.8 -> 0.45, transfer 0.12 -> 0.08, max delta 7 -> 4) so bumping into
// an orb doesn't fling the spoon around as hard, across all difficulties.
// ============================================================================
export const ORB_COLLISION_RESTITUTION = 0  // how much the inward velocity component bounces back outward
export const ORB_COLLISION_PUSH        = 0 // px/frame guaranteed outward nudge along the contact normal
export const ORB_COLLISION_TRANSFER    = 0  // fraction of the orb's own velocity imparted to the spoon
export const ORB_COLLISION_MAX_DELTA   = 0     // cap on the total velocity change from any single orb touch

// ============================================================================
// PLAYER PROPERTIES
// ============================================================================

export const P_RADIUS_START    = 20
export const P_RADIUS_MIN      = 8
export const SHRINK_PER_HIT    = 4
export const SHRINK_COOLDOWN   = 900        // ms

// ============================================================================
// ARENA BOUNDARIES & ZONES
// ============================================================================

// Widened from 540 -> 600 ("widen the whole arena a bit") — GAME_HEIGHT
// unchanged. ZONE_LEFT/ZONE_RIGHT/CEILING_Y/FLOOR_Y below are all derived
// from GAME_WIDTH/GAME_HEIGHT, and every draw/physics call site in
// GameEngine.js/OrbSystem.js/ArenaSystem.js already reads GAME_WIDTH rather
// than a hardcoded 540, so this cascades cleanly. The one place this can't
// reach is plain CSS (mobile.css's .game-wrapper--mobile, desktop.css's
// .tutorial-wrapper) — both hardcode 540/720 in px because CSS can't import
// a JS constant; keep those in sync by hand if this ever changes again.
export const GAME_WIDTH        = 600
export const GAME_HEIGHT       = 720

// Play zone – physics collision between these X edges
export const ZONE_LEFT         = 40          // left wall x-position
export const ZONE_RIGHT        = GAME_WIDTH - 26 // right wall x-position — was GAME_WIDTH - 2, pulled back in per request (right collision wall sat too far right/out toward the edge)
export const CEILING_Y         = 20          // ceiling y-position
export const FLOOR_Y            = GAME_HEIGHT - 48 // floor y-position (death zone)

// Zone width for reference
export const PLAY_ZONE_WIDTH   = ZONE_RIGHT - ZONE_LEFT

// ============================================================================
// HEALTH BAR SYSTEM
// ============================================================================

export const MAX_HEALTH         = 100        // health bar: 0-100
export const WALL_DAMAGE        = 12         // damage from left/right wall bounce
export const CEILING_DAMAGE     = 0         // damage from ceiling bounce

// ============================================================================
// COLLECTIBLES
// ============================================================================

export const COLL_R            = 10
export const COLL_SPAWN_MS     = 950
export const COLL_LIFETIME_MS  = 6000
export const COLL_BATCH_MIN    = 2
export const COLL_BATCH_MAX    = 4
export const COLL_MIN_X        = ZONE_LEFT  + 30
export const COLL_MAX_X        = ZONE_RIGHT - 30
export const COLL_MIN_Y        = CEILING_Y  + 20
export const COLL_MAX_Y        = FLOOR_Y    - 20

// ============================================================================
// OBSTACLES (Hidden visually, still collide)
// ============================================================================

export const OBS_W             = 28
export const OBS_H_MIN         = 50
export const OBS_H_MAX         = 110
export const OBS_SPAWN_DELAY   = 1800        // ms between spawns
export const OBS_SLIDE_FRAMES  = 18          // slide-in animation frames
export const SHOW_OBSTACLES    = false       // visually hidden
export const WARNING_MS        = 1200        // obstacle warning duration

// ============================================================================
// SHIELD POWER-UP
// ============================================================================

export const SHIELD_CHANCE     = 0.20
export const SHIELD_DURATION   = 6000        // ms
export const SHIELD_R          = 13

// ============================================================================
// PHYSICS TUNING PRESETS (for difficulty scaling)
// ============================================================================
// Tuning pass: Easy's wall/ceiling bounce energy used to be 3.00 (i.e. the
// spoon GAINED 300% energy on every bounce — objectively the least
// controllable setting in the game, not the friendliest). That's now been
// dropped well below 1.0 so bounces are soft and easy to recover from.
// Normal and Hard were also nudged down (gravity, bounce energy, ceiling
// bounce) and air control nudged up, to make them more forgiving/playable
// without removing their extra challenge relative to Easy. Each preset now
// also carries its own LAUNCH_MIN_SPEED / LAUNCH_MAX_SPEED so Easy's
// drag/swipe launches are noticeably slower than Hard's; wire these in
// wherever the base LAUNCH_MIN_SPEED/LAUNCH_MAX_SPEED constants are read,
// keyed off the active difficulty.
// (Ceiling bounce further softened across all three tiers on a follow-up
// pass - the values are now noticeably lower than the wall bounce values so
// the ceiling feels distinctly slower/gentler than a wall hit.)

export const DIFFICULTY_EASY = {
  GRAVITY: 0.05,
  FLAP_VY: -13,
  WALL_BOUNCE_ENERGY: 0.40,      // was 3.00 - now a soft, easy-to-control bounce
  CEILING_BOUNCE_ENERGY: 0.07,   // was 3.00, then 0.20 - now very soft, slow ceiling bounce
  AIR_CONTROL_POWER: 1.0,
  COYOTE_TIME_FRAMES: 12,
  LAUNCH_MIN_SPEED: 4,           // slower drag/swipe launches on Easy
  LAUNCH_MAX_SPEED: 7,
}

export const DIFFICULTY_NORMAL = {
  GRAVITY: 0.22,                 // was 0.3 - slightly floatier, more reaction time
  FLAP_VY: -11,
  WALL_BOUNCE_ENERGY: 0.55,      // was 0.66 - softer wall bounce
  CEILING_BOUNCE_ENERGY: 0.10,   // was 0.35, then 0.25 - now softer/slower ceiling bounce
  AIR_CONTROL_POWER: 0.9,        // was 0.8 - a bit more steering control
  COYOTE_TIME_FRAMES: 8,
  LAUNCH_MIN_SPEED: 5,
  LAUNCH_MAX_SPEED: 14,
}

export const DIFFICULTY_HARD = {
  GRAVITY: 0.42,                 // was 0.50 - still fast, but survivable
  FLAP_VY: -9,
  WALL_BOUNCE_ENERGY: 0.78,      // was 0.92 - still bouncy, more recoverable
  CEILING_BOUNCE_ENERGY: 0.15,   // was 0.65, then 0.50 - noticeably softer/slower ceiling bounce
  AIR_CONTROL_POWER: 0.6,        // was 0.5 - a little more control room
  COYOTE_TIME_FRAMES: 5,         // was 4
  LAUNCH_MIN_SPEED: 6,
  LAUNCH_MAX_SPEED: 17,
}

// Collectible tint colours (CSS hex strings)
export const COLL_COLOURS = ['#7fffa8', '#55ddff', '#ffff77', '#ff99dd', '#aaffee']

// ============================================================================
// ORB SYSTEM CONSTANTS
// ============================================================================

export const ORB_BASE_SPEED       = 2.2
export const ORB_MAX_ACTIVE       = 20
export const ORB_SPAWN_INTERVAL_MS = 800
export const ORB_MIN_X = ZONE_LEFT  + 30
export const ORB_MAX_X = ZONE_RIGHT - 30
export const ORB_MIN_Y = CEILING_Y  + 40
export const ORB_MAX_Y = FLOOR_Y    - 40

// Lava Orb
export const LAVA_ORB_BASE_SCORE = 1   // was 10, per request
export const LAVA_ORB_SPEED      = 2.2
export const LAVA_ORB_RADIUS     = 13  // was 11, slightly bigger per request
export const LAVA_ORB_WEIGHT     = 60

// ============================================================================
// COIN SYSTEM — separate currency from score / the NFT marketplace wallet.
// Every lava orb collected is worth this many coins, saved to a cumulative,
// never-resets total alongside the score.
// ============================================================================
export const COIN_PER_LAVA_ORB = 1

// Turbo Orb
export const TURBO_ORB_WEIGHT    = 4
export const TURBO_ORB_SPEED     = 4.5
export const TURBO_ORB_RADIUS    = 13
export const TURBO_DURATION_MS   = 7000
export const TURBO_COMBO_MULTIPLIER = 2.0

// Jackpot Orb
export const JACKPOT_ORB_WEIGHT  = 2
export const JACKPOT_ORB_SPEED   = 3.8
export const JACKPOT_ORB_RADIUS  = 16
export const JACKPOT_LIFETIME_MS = 4500
export const JACKPOT_BASE_POINTS = 500

// Bad Rock
export const BAD_ROCK_WEIGHT       = 12
export const BAD_ROCK_SPEED        = 1.8
export const BAD_ROCK_RADIUS       = 14
export const BAD_ROCK_SCORE_PENALTY = 20

// Fire Wall Orb
export const FIRE_WALL_WEIGHT            = 8
export const FIRE_WALL_RADIUS            = 10
export const FIRE_WALL_HAZARD_DURATION_MS = 5000
export const FIRE_WALL_ORB_SPEED         = 2.0   // now floats like other orbs

// Lava Stick hazards (spawned on walls when a Fire Wall orb is collected)
export const LAVA_STICK_RADIUS      = 13
export const LAVA_STICK_DAMAGE      = 15
export const LAVA_STICK_LIFETIME_MS = FIRE_WALL_HAZARD_DURATION_MS
export const LAVA_STICK_COUNT       = 2   // how many sticks spawn per fire-wall pickup

// Magnet Orb
export const MAGNET_ORB_WEIGHT    = 6
export const MAGNET_ORB_RADIUS    = 13
export const MAGNET_DURATION_MS   = 7000
export const MAGNET_PULL_RADIUS   = 120
export const MAGNET_PULL_STRENGTH = 0.4

// Freeze Orb
export const FREEZE_ORB_WEIGHT   = 6
export const FREEZE_ORB_RADIUS   = 12
export const FREEZE_DURATION_MS  = 4000
export const FREEZE_SPEED_FACTOR = 0.35

// Shield Orb
export const SHIELD_ORB_WEIGHT      = 6
export const SHIELD_ORB_RADIUS      = 13
export const SHIELD_ORB_DURATION_MS = 3000  // 3-second shield duration
export const SHIELD_ORB_HITS        = 1

// Gravity Orb
export const GRAVITY_ORB_WEIGHT       = 5
export const GRAVITY_ORB_RADIUS       = 12
export const GRAVITY_REDUCTION_FACTOR = 0.45
export const GRAVITY_ORB_DURATION_MS  = 6000

// How long the player's spoon shows the sprite of the last orb it collected
// (see GameLogic._resolvePlayerSkin) before reverting to the player's own
// equipped Spoon Skin. This is a cosmetic "pickup flash", not a gameplay
// powerup — it used to never expire at all (the orb sprite stuck for the
// rest of the run, permanently hiding the player's equipped skin), so this
// gives it the same time-limited treatment as the real powerup skins
// (turbo/shield/freeze/gravity/magnet) above.
export const ORB_SKIN_DISPLAY_MS = 1500

// Chaos Orb
export const CHAOS_ORB_WEIGHT  = 5
export const CHAOS_ORB_RADIUS  = 14
export const CHAOS_EFFECTS = [
  'score_boost',
  'reverse_controls',
  'speed_spike',
  'orb_rain',
  'invincibility',
  'hazard_burst',
]

// Mythic Event Orb
export const MYTHIC_ORB_WEIGHT          = 1
export const MYTHIC_ORB_RADIUS          = 11
export const MYTHIC_ORB_SPEED           = 1.5
export const MYTHIC_LIFETIME_MS         = 6000
export const MYTHIC_JACKPOT_MULTIPLIER  = 10
export const MYTHIC_SEASONAL_BONUS      = 1000

// ============================================================================
// COMBO SYSTEM
// ============================================================================
export const COMBO_THRESHOLDS  = [1, 3, 7, 15, 30]
export const COMBO_MULTIPLIERS = [1, 2, 3, 5, 10]
export const COMBO_TIMEOUT_MS  = 4000

// ============================================================================
// ADAPTIVE DIFFICULTY (HIDDEN)
// ============================================================================
export const STRUGGLE_DEATH_WINDOW_MS    = 15000
export const STRUGGLE_DEATH_THRESHOLD   = 3
export const STRUGGLE_SURVIVAL_THRESHOLD = 10000
export const STRUGGLE_COMBO_THRESHOLD   = 2
export const STRUGGLE_FREEZE_BOOST      = 2.5
export const STRUGGLE_SHIELD_BOOST      = 2.5
export const STRUGGLE_HAZARD_REDUCTION  = 0.5
export const STRUGGLE_SPEED_REDUCTION   = 0.8

// ============================================================================
// PROGRESSIVE DIFFICULTY SCALING
// ============================================================================
export const DIFF_SCALE_INTERVAL_MS   = 20000
export const DIFF_MAX_STAGES          = 8
export const DIFF_SPEED_INCREMENT     = 0.18
export const DIFF_GRAVITY_INCREMENT   = 0.03
export const DIFF_SPAWN_ACCELERATION  = 0.92
export const DIFF_HAZARD_WEIGHT_BOOST = 1.15

// Start the game noticeably slower; progressive scaling ramps it back up
// to (and past) the original baseline over the first few stages.
export const DIFF_START_SPEED_MULTIPLIER   = 0.55
export const DIFF_START_GRAVITY_MULTIPLIER = 0.80
export const DIFF_START_SPAWN_MULTIPLIER   = 1.4

// Mobile starts EXTREMELY slow — smaller screen + touch input needs much
// more reaction time than desktop. Ramps up through the same
// DIFF_SPEED_INCREMENT / DIFF_GRAVITY_INCREMENT stages until it converges
// on ordinary difficulty. isMobile is reported by the client on
// game:start / game:restart — apply this preset instead of the desktop one
// above whenever that flag is true (see wiring note below).
export const DIFF_START_SPEED_MULTIPLIER_MOBILE   = 0.12   // was 0.28 — extremely slow start
export const DIFF_START_GRAVITY_MULTIPLIER_MOBILE = 0.18   // was 0.45
export const DIFF_START_SPAWN_MULTIPLIER_MOBILE   = 2.6    // was 1.9 — orbs/hazards spawn far less often

// ============================================================================
// ARENA EVOLUTION EVENTS
// ============================================================================
export const ARENA_EVENT_INTERVAL_MS  = 14000  // was 25000 — hazards felt too rare per playtest
export const ARENA_LAVA_RAIN_COUNT    = 6
export const ARENA_EARTHQUAKE_SHAKE   = 8
export const ARENA_EARTHQUAKE_MS      = 2500
export const ARENA_DARKNESS_ALPHA     = 0.97
export const ARENA_DARKNESS_MS        = 7000
export const ARENA_WIND_FORCE         = 1.2
export const ARENA_WIND_MS            = 6000

// ============================================================================
// BOSS EVENT SYSTEM
// ============================================================================
export const BOSS_TRIGGER_SURVIVAL_MS  = 60000
export const BOSS_REPEAT_INTERVAL_MS   = 45000
export const BOSS_ORB_STORM_COUNT      = 14
export const BOSS_ERUPTION_WAVES       = 3
export const BOSS_WAVE_INTERVAL_MS     = 2200
export const BOSS_SURVIVAL_DURATION_MS = 12000
export const TICK_MS = 1000 / 60

// ============================================================================
// NEW ORB TYPES (frontend — mirrors backend constants.js)
// ============================================================================

export const COMBO_ORB_WEIGHT   = 8
export const COMBO_ORB_SPEED    = 2.4
export const COMBO_ORB_RADIUS   = 12
export const COMBO_ORB_BOOST    = 2

export const ROSE_ORB_WEIGHT    = 5
export const ROSE_ORB_RADIUS    = 11
export const ROSE_ORB_SPEED     = 1.8
export const ROSE_ORB_HEAL      = 15

export const HEALTH_ORB_WEIGHT   = 0.2
export const HEALTH_ORB_RADIUS   = 12
export const HEALTH_ORB_SPEED    = 1.6
export const HEALTH_ORB_HEAL     = 25
// Was missing entirely — OrbSystem.js imports it but it had never been
// exported here, which broke the moment this file was actually bundled
// (previously unreachable dead code; see GameLogic.js's new import of
// OrbSystem.js). Matches the generic standard-tier collectible lifetime
// (COLL_LIFETIME_MS/MYTHIC_LIFETIME_MS) used elsewhere in this file.
export const HEALTH_ORB_LIFETIME_MS = 6000

export const BLACK_ORB_WEIGHT       = 2
export const BLACK_ORB_RADIUS       = 13
export const BLACK_ORB_SPEED        = 2.5
export const BLACK_ORB_SCORE_PENALTY = 30
export const BLACK_ORB_DISTORT_MS   = 2000

export const SUN_FLAME_ORB_WEIGHT   = 3
export const SUN_FLAME_ORB_RADIUS   = 14
export const SUN_FLAME_ORB_SPEED    = 3.0
export const SUN_FLAME_ORB_BONUS    = 50
export const SUN_FLAME_LIFETIME_MS  = 5000

export const ELECTRIC_ORB_WEIGHT    = 3
export const ELECTRIC_ORB_RADIUS    = 13
export const ELECTRIC_ORB_SPEED     = 2.8
export const ELECTRIC_SHOCK_MS      = 1500
export const ELECTRIC_COLLECT_RADIUS = 110
export const ELECTRIC_LIFETIME_MS   = 5500

export const DIAMOND_ORB_WEIGHT     = 0.5
export const DIAMOND_ORB_RADIUS     = 18
export const DIAMOND_ORB_SPEED      = 3.5
export const DIAMOND_LIFETIME_MS    = 1200
export const DIAMOND_BASE_POINTS    = 2000

// ============================================================================
// NFT ARTIFACT PERKS — small passive gameplay bonuses for owning specific
// catalog artifacts. Which artifacts map to which perk is the admin-set
// `perkKey` field on each catalog entry (backend/src/models/Nft.js), joined
// against ownership client-side in nftData.js (getActivePerks/
// syncArtifactPerksFromServer); the client reports the resulting boolean
// flags to the server on game:start/game:restart, and GameLogic applies
// the actual numbers below. Hazard visibility (Greek Temple Artifact) is
// purely a client-side rendering perk and has no server-side constant.
// ============================================================================
export const ARTIFACT_HEAL_PER_MINUTE           = 4     // Tribal Spirit Artifact (Africa) — slow passive HP regen
export const ARTIFACT_PICKUP_RADIUS_BONUS       = 6     // Ancient Dragon Artifact (China) — px added to orb pickup radius
export const ARTIFACT_COMBO_DURATION_MULTIPLIER = 1.02  // Maya Sun Artifact — +2% combo timeout window
export const ARTIFACT_COMBO_STABILIZE_RETENTION = 0.5   // Dino Fossil Artifact — fraction of combo kept on a hazard break

// ============================================================================
// LAVA COIN ORB REWARDS & PENALTIES
// Additional Lava Coin effects layered on top of existing orb mechanics.
// ============================================================================
export const TURBO_ORB_COIN_MIN          = 15   // Turbo: grant +15 to +30 Lava Coins
export const TURBO_ORB_COIN_MAX          = 30
export const CHAOS_ORB_COIN_MIN          = 100  // Chaos: grant +100 to +500 Lava Coins
export const CHAOS_ORB_COIN_MAX          = 500
export const FIRE_WALL_COIN_PENALTY_MIN  = 25   // Fire Wall: deduct 25 to 75 Lava Coins
export const FIRE_WALL_COIN_PENALTY_MAX  = 75
export const BAD_ROCK_COIN_PENALTY_MIN   = 50   // Bad Rock: deduct 50 to 150 Lava Coins
export const BAD_ROCK_COIN_PENALTY_MAX   = 150
export const JACKPOT_COIN_MIN            = 500  // Jackpot: massive Lava Coin reward
export const JACKPOT_COIN_MAX            = 2000
export const JACKPOT_COMBO_BOOST         = 15   // Jackpot: simulate this many lava orbs for combo boost

// ============================================================================
// WORLD EVENT SYSTEM — Automatic hazard constants
// ============================================================================
export const LAVA_RAIN_WARNING_MS      = 1200
export const LAVA_RAIN_DROP_RADIUS     = 25
export const LAVA_RAIN_DROP_DAMAGE     = 6
export const LAVA_RAIN_DROP_COUNT      = 5
export const LAVA_WALL_SPEED           = 1.0
export const LAVA_WALL_WIDTH           = 65
export const LAVA_WALL_DAMAGE          = 25
export const LAVA_WALL_DAMAGE_COOLDOWN = 90
export const LAVA_WALL_DURATION_MS     = 10000
export const ORB_STORM_POSITIVE_COUNT  = 10
export const ORB_STORM_NEGATIVE_COUNT  = 6
export const WORLD_EVENT_MIN_INTERVAL_MS = 5000  // was 8000 — hazards felt too rare per playtest
export const JACKPOT_NFT_CHANCE          = 0.15 // 15% chance of NFT reward on jackpot

// ============================================================================
// GAME FEEL — Freeze Frames, Camera Zoom, Screen Flash
// ============================================================================
export const FREEZE_JACKPOT_MS     = 80
export const FREEZE_COMBO_MS       = 60
export const FREEZE_BOSS_MS        = 100
export const FREEZE_NEAR_DEATH_MS  = 50
export const FREEZE_LAVA_COIN_MS   = 70

export const ZOOM_TURBO    = 1.20
export const ZOOM_JACKPOT  = 1.35
export const ZOOM_BOSS     = 1.30
export const ZOOM_COMBO    = 1.15
export const ZOOM_EVENT    = 1.18
export const ZOOM_DURATION_MS = 1800
export const ZOOM_LERP_SPEED  = 0.15

export const SHAKE_SMALL  = 4
export const SHAKE_MEDIUM = 9
export const SHAKE_LARGE  = 18

export const FLASH_JACKPOT = '#ffd700'
export const FLASH_BOSS    = '#ff4400'
export const FLASH_DAMAGE  = '#ff2020'
export const FLASH_COIN    = '#ffcc00'
export const FLASH_TURBO   = '#00ffcc'
export const FLASH_MYTHIC  = '#cc88ff'
export const FLASH_CHAOS   = '#ff44ff'
export const FLASH_ALPHA   = 0.30
export const FLASH_DECAY   = 0.045

// SLOW MOTION — brief cinematic punch (does NOT disrupt gameplay balance)
// Keep durations short so the speed asymmetry between player and orbs is imperceptible
export const SLOW_MO_JACKPOT_FACTOR    = 0.65   // 65% speed — subtle punch
export const SLOW_MO_JACKPOT_MS        = 120    // 120ms — ~7 physics ticks
export const SLOW_MO_MYTHIC_FACTOR     = 0.55
export const SLOW_MO_MYTHIC_MS         = 180
export const SLOW_MO_CHAOS_FACTOR      = 0.70
export const SLOW_MO_CHAOS_MS          = 100
export const SLOW_MO_NEAR_DEATH_FACTOR = 0.70
export const SLOW_MO_NEAR_DEATH_MS     = 80
export const SLOW_MO_BOSS_FACTOR       = 0.60
export const SLOW_MO_BOSS_MS           = 150

// ============================================================================
// MATCH MODIFIERS — Rotating daily/event modifiers
// ============================================================================
export const MODIFIER_ORB_SURGE_MULT    = 1.5
export const MODIFIER_SPEED_DEMON_MULT  = 1.4
export const MODIFIER_COIN_RUSH_MULT    = 2.0
export const MODIFIER_GALE_FORCE_MULT   = 2.0
export const MODIFIER_QUICK_HANDS_MULT  = 0.5
// ── Arena-Stage Orb Unlocks ─────────────────────────────────────────────
// Additive gate on top of the existing Level-based unlock order in
// LevelSystem.js — a type only ever spawns once BOTH its Level AND its
// (persistent, cross-run) Arena Stage requirement are satisfied. Mirrors
// the backend's OrbSystem.js JACKPOT_MIN_ARENA_STAGE / MYTHIC_MIN_ARENA_STAGE
// / POWERUP_STAGE_GATES exactly (for the orb types this frontend engine
// actually has — backend's "rose"/"combo"/"black" types have no frontend
// counterpart yet).
export const JACKPOT_MIN_ARENA_STAGE = 3
export const MYTHIC_MIN_ARENA_STAGE  = 8
export const SHIELD_MIN_ARENA_STAGE  = 1  // available from Stage 1 — the very first support orb
export const MAGNET_MIN_ARENA_STAGE  = 3
export const HEALTH_MIN_ARENA_STAGE  = 4
export const FREEZE_MIN_ARENA_STAGE  = 5
export const GRAVITY_MIN_ARENA_STAGE = 6  // last one — full roster from Stage 6 onward
// Restored for routes/arenaStages.js's ARENA_STAGE_CONFIGS compatibility
// layer (see arenaStages.js) -- not otherwise used by the current
// frontend-derived OrbSystem/GameLogic, which don't gate combo/rose orbs by
// arena stage the way shield/magnet/health/freeze/gravity are gated above.
export const COMBO_MIN_ARENA_STAGE = 2
export const ROSE_MIN_ARENA_STAGE = 4

// ── Wall Spikes hazard (ported from backend — was never wired up on the
// frontend engine at all, so it could never appear during a real run) ──
export const WALL_SPIKES_COUNT              = 4      // spikes spawned per wall at baseline density
export const WALL_SPIKES_LENGTH             = 46     // px a fully-extended spike reaches into the arena
export const WALL_SPIKES_THICKNESS          = 44     // vertical hit-height of a spike
export const WALL_SPIKES_CYCLE_MS           = 1500   // one full retract->extend->retract cycle
export const WALL_SPIKES_DURATION_MS        = 5000   // how long the whole wall-spikes event stays active
export const WALL_SPIKES_WARNING_MS         = 900    // telegraph window before spikes can hurt
export const WALL_SPIKES_DAMAGE             = 18
export const WALL_SPIKES_DAMAGE_COOLDOWN_MS = 700

// ── Ninja Knives hazard (same — ported from backend, never wired up here) ──
export const NINJA_KNIFE_SPEED              = 3.4    // baseline px/frame horizontal speed
export const NINJA_KNIFE_RADIUS             = 14     // collision radius
export const NINJA_KNIFE_DAMAGE             = 15
export const NINJA_KNIFE_WARNING_MS         = 850
export const NINJA_KNIFE_VOLLEY_MIN         = 2
export const NINJA_KNIFE_VOLLEY_MAX         = 4
export const NINJA_KNIFE_VOLLEY_STAGGER_MS  = 110
export const NINJA_KNIFE_BANDS = [
  [0.10, 0.32],   // upper
  [0.38, 0.62],   // middle
  [0.68, 0.90],   // lower
]

// Baseline cadence for the independent wall-spike / ninja-knife schedulers
// (kept separate from the big world-event rotation — see arenaStages.js's
// STAGE_LIGHT_HAZARD_FREQUENCY). Scaled by each arena stage's light-hazard
// frequency multiplier, with a floor so they never fire absurdly often.
export const WALL_SPIKES_INTERVAL_MS     = 9000
export const WALL_SPIKES_MIN_INTERVAL_MS = 3000
export const NINJA_KNIFE_INTERVAL_MS     = 4200
export const NINJA_KNIFE_MIN_INTERVAL_MS = 1200

// ============================================================================
// BASIC ANTI-BOT INPUT PLAUSIBILITY (Developer Update, 30 Sep 2026)
// ============================================================================
// Runs on top of the existing server replay (see game/inputPlausibility.js)
// — these look at the SHAPE of a run's discrete launch inputs, not just
// its final score/coin totals. All timing here is measured against the
// server's own frame-derived virtual clock, never a client-claimed
// timestamp (same rule the replay/duration checks above already follow).

// A human drag-release-drag cycle takes real time — this is a generous
// floor under how fast two separate launch inputs in the SAME run can
// legitimately land. Below this, the input stream reflects an automated
// script firing inputs, not a hand on a touchscreen/mouse.
export const MIN_HUMAN_INPUT_INTERVAL_MS = 70

// A raw (unclamped) drag magnitude far beyond anything the UI itself can
// ever produce (DRAG_MAX_PX already maps to maximum launch force — nothing
// further out does anything extra) isn't "a big drag", it's a forged/
// injected input payload. Reject outright rather than silently clamping it
// and saying nothing.
export const LAUNCH_MAGNITUDE_REJECT_PX = DRAG_MAX_PX * 4

// Scripted-movement detection: near-zero variance in the timing between
// inputs, across enough inputs to rule out coincidence, is a strong signal
// of an automated input script rather than a human playing by hand. This is
// a MONITORING signal only — flagged for admin review, never an auto-
// reject (a genuinely metronomic human run is rare but not impossible; a
// person should decide, not an auto-ban — see the Developer Update).
export const SCRIPTED_TIMING_MIN_SAMPLE    = 6   // need at least this many intervals to judge
export const SCRIPTED_TIMING_MAX_STDDEV_MS = 4   // below this stddev, timing reads as machine-regular

// ============================================================================
// RUN-REPORT PLAUSIBILITY CEILING (backend anti-cheat)
// ============================================================================
// Physics/movement/orb collection now runs entirely on the client (see
// ClientSession.js's game:run_report handling) — the server no longer ticks
// a live simulation for real runs, so it can't verify a run's score/coins by
// re-deriving them frame-by-frame the way it used to. Instead, at game over
// the client reports final score/coins/jackpotTokens once, and the server
// checks that report against a generous ceiling derived from the same spawn/
// value constants above, using its OWN clock for elapsed time (never the
// client's claimed duration). A legitimate best-possible run should never
// come close to this ceiling; it exists to catch a report that is wildly
// larger than anything achievable, not to micro-referee normal play.
//
// Steady-state: every collectible wave (COLL_SPAWN_MS apart) can contain up
// to COLL_BATCH_MAX collectibles; assume, generously, that ALL of them could
// be lava/coin orbs worth COIN_PER_LAVA_ORB each.
export const RUN_MAX_COINS_PER_SEC =
  (COLL_BATCH_MAX / (COLL_SPAWN_MS / 1000)) * COIN_PER_LAVA_ORB * 3
// ^ ×3 headroom for combo multipliers / powerups / difficulty-scaled batch
// sizes at higher arena stages that aren't worth modelling exactly here.

// Rare-orb burst allowance: a per-minute coin budget on top of the steady
// rate, sized off the biggest single payouts in the game (JACKPOT_COIN_MAX,
// MYTHIC_JACKPOT_MULTIPLIER), generous enough to cover an eruption window's
// boosted rare-orb weights (see BOSS_SURVIVAL_DURATION_MS) without needing
// to simulate spawn odds server-side.
export const RUN_MAX_RARE_COINS_PER_MIN = JACKPOT_COIN_MAX * 3
export const RUN_MAX_MYTHIC_COINS_PER_MIN =
  JACKPOT_COIN_MAX * MYTHIC_JACKPOT_MULTIPLIER + MYTHIC_SEASONAL_BONUS

// Jackpot Tokens — 1 per natural Jackpot Orb collected (see ClientSession's
// saveJackpotTokens); bound by how often a Jackpot Orb can realistically be
// collected (its own lifetime is the tightest natural cap).
export const RUN_MAX_JACKPOT_TOKENS_PER_MIN =
  Math.ceil(60000 / JACKPOT_LIFETIME_MS) * 4

// Score ceiling — looser than the coin checks (score isn't spendable, but it
// does feed the leaderboard, so it still shouldn't be free-form). One point
// per collectible, same steady/burst shape as coins above, without the
// per-arena coin multiplier.
export const RUN_MAX_SCORE_PER_SEC = RUN_MAX_COINS_PER_SEC * 4

// A run report's claimed duration is never trusted on its own — the server
// measures elapsed time from when it issued the run token — but these bound
// how long a token stays valid at all.
export const RUN_TOKEN_MIN_MS = 250   // shorter than this can't have scored anything real
export const RUN_TOKEN_MAX_MS = 2 * 60 * 60 * 1000 // 2h — generous ceiling against a stale/replayed token

// Energy "failed start" refund window (see ClientSession._refundEnergyIfEarly)
// — deliberately a SEPARATE, much larger constant than RUN_TOKEN_MIN_MS
// above: that one bounds a physically-possible COMPLETED run, this one
// bounds how soon after issuing a run token its Energy charge is still
// refundable if the round never got used (token discarded by a fresh
// game:restart superseding it, or the socket disconnecting before any
// run_report arrives). Deliberately conservative/short — this is only
// meant to catch a genuine start failure (network blip before the token
// even arrived, an accidental double-tap that fired two restarts), never
// as a general "abandoned mid-play run" refund policy (that's an explicit
// owner decision — see the handover doc's S4 note on abandoned-match
// rewards — and is NOT what this constant is for).
export const RUN_START_REFUND_WINDOW_MS = 5000

// Overall multiplier applied to every ceiling above before a report is
// clamped/rejected — extra slack so an imperfect formula never punishes a
// genuinely great (but honest) run.
export const RUN_REPORT_SAFETY_MARGIN = 1.5

// ============================================================================
// GAME:RESTART RATE LIMITING (see RateLimiter.js / ClientSession.js)
// ============================================================================
// Even with server-side replay validation, nothing stops a scripted client
// from running THIS SAME (open-source, client-side) GameLogic itself to
// pre-compute a good-looking input log for a given seed and submit it —
// replay validation only proves a report's numbers came from actually
// simulating the seed, not that a human played it. Throttling how often a
// single user/IP can even START a run bounds that residual risk to
// realistic play cadence, same as it always did for the old clamp-based
// system. Tuned generously against normal play (short runs, quick
// restarts after an early death); re-derive from real telemetry before
// tightening further, same caution as every RUN_MAX_* constant above.
export const RESTART_MIN_GAP_MS = 600          // can't restart faster than this, ever
export const RESTART_WINDOW_MS = 5 * 60 * 1000  // 5 minutes
export const RESTART_MAX_PER_WINDOW = 60        // ~1 every 5s sustained — generous for quick deaths
export const RESTART_MAX_PER_WINDOW_PER_IP = 150 // looser — one IP can legitimately be several players (NAT/shared network)

// Extra layer that ONLY applies while Unlimited Energy is active for this
// user (see EnergyService.js's unlimitedActive) — that's exactly the mode
// where the Energy system's own natural throttle (1 Energy per run) is
// gone, so a bot scripting optimal play could otherwise restart as fast as
// the WS round trip allows. Same idea as RESTART_MAX_PER_WINDOW above, just
// tighter and on a shorter window so it bites quickly during an Unlimited
// Energy session instead of only after minutes of sustained abuse.
export const RESTART_MIN_GAP_MS_UNLIMITED = 1200
export const RESTART_WINDOW_MS_UNLIMITED = 60 * 1000
export const RESTART_MAX_PER_WINDOW_UNLIMITED = 20

