import '../src/game/ArcadePhysicsEngine.js'
import '../src/game/PhysicsEngine.js'
import '../src/game/GameLogic.js'
import '../src/game/ReplayEngine.js'
import '../src/game/seededRandom.js'
import '../src/game/simClock.js'
// AuthoritativeGame.js was removed 2026-09-15 — unused, non-deterministic
// (Math.random()-based) prototype of a different game (flap/dodge-obstacle,
// FLAP_VY/OBS_W constants), superseded by the seeded GameLogic + ReplayEngine
// replay design above. See the run-report anti-cheat fix notes.

console.log('Build check passed: gameplay modules loaded successfully.')
