import { GameLogic as ClientGameLogic } from '../../Frontend/src/game/GameLogic.js';
import { seedRandom as clientSeedRandom } from '../../Frontend/src/game/seededRandom.js';
import { setSimClock as clientSetSimClock } from '../../Frontend/src/game/simClock.js';

import { GameLogic as ServerGameLogic } from '../src/game/GameLogic.js';
import { seedRandom as serverSeedRandom } from '../src/game/seededRandom.js';
import { setSimClock as serverSetSimClock } from '../src/game/simClock.js';

function simulateClientRun({ seed, stage = 1, inputs = [], frames = [] }) {
  clientSeedRandom(seed);
  let simNow = 0;
  clientSetSimClock(() => simNow);

  const game = new ClientGameLogic();
  game.reset();
  game.setArenaStage(stage);

  const sortedInputs = [...inputs].sort((a, b) => a.atFrame - b.atFrame);
  let inputIdx = 0;

  const clientHistory = [];

  for (let i = 0; i < frames.length; i++) {
    while (inputIdx < sortedInputs.length && sortedInputs[inputIdx].atFrame <= i) {
      const inp = sortedInputs[inputIdx];
      game.handleInput(inp.type, { dx: inp.dx, dy: inp.dy });
      inputIdx++;
    }

    const dt = frames[i];
    game.update(dt);
    simNow += dt * 16.667;

    clientHistory.push({
      frame: i,
      dt,
      x: game.physics.x,
      y: game.physics.y,
      vx: game.physics.vx,
      vy: game.physics.vy,
      score: game.score,
      coins: game.coins,
      health: game.health,
      gameOver: game.gameOver,
      orbCount: game.orbs?.orbs?.length ?? 0
    });

    if (game.gameOver) break;
  }

  clientSetSimClock(null);
  clientSeedRandom(NaN);

  return { game, clientHistory };
}

function simulateServerRun({ seed, stage = 1, inputs = [], frames = [], allowDtZero = false }) {
  serverSeedRandom(seed);
  let simNow = 0;
  serverSetSimClock(() => simNow);

  const game = new ServerGameLogic();
  game.reset();
  game.setArenaStage(stage);

  const sortedInputs = [...inputs].sort((a, b) => a.atFrame - b.atFrame);
  let inputIdx = 0;

  const serverHistory = [];

  for (let i = 0; i < frames.length; i++) {
    while (inputIdx < sortedInputs.length && sortedInputs[inputIdx].atFrame <= i) {
      const inp = sortedInputs[inputIdx];
      game.handleInput(inp.type, { dx: inp.dx, dy: inp.dy });
      inputIdx++;
    }

    const rawDt = Number(frames[i]);
    const dt = allowDtZero
      ? (Number.isFinite(rawDt) && rawDt >= 0 ? Math.min(3, rawDt) : 1)
      : (Number.isFinite(rawDt) && rawDt > 0 ? Math.min(3, rawDt) : 1);

    game.update(dt);
    simNow += dt * 16.667;

    serverHistory.push({
      frame: i,
      dt,
      x: game.physics.x,
      y: game.physics.y,
      vx: game.physics.vx,
      vy: game.physics.vy,
      score: game.score,
      coins: game.coins,
      health: game.health,
      gameOver: game.gameOver,
      orbCount: game.orbs?.orbs?.length ?? 0
    });

    if (game.gameOver) break;
  }

  serverSetSimClock(null);
  serverSeedRandom(NaN);

  return { game, serverHistory };
}

console.log('=== TEST 1: CURRENT SERVER BEHAVIOR (rawDt > 0 fallback to 1) ===');
for (const stage of [1, 2, 3, 4]) {
  console.log(`\n--- Stage ${stage} ---`);
  for (let s = 1; s <= 3; s++) {
    const seed = 54321 + s * 1000 + stage * 50;
    // Typical real client: first frame has dt = 0!
    const frames = [0];
    for (let f = 1; f < 200; f++) frames.push(0.95 + ((f * 17) % 11) * 0.01);
    const inputs = [{ atFrame: 0, type: 'launch', dx: 25, dy: -70 }, { atFrame: 40, type: 'launch', dx: -15, dy: -60 }];

    const client = simulateClientRun({ seed, stage, inputs, frames });
    const server = simulateServerRun({ seed, stage, inputs, frames, allowDtZero: false });

    let diff = null;
    const minLen = Math.min(client.clientHistory.length, server.serverHistory.length);
    for (let f = 0; f < minLen; f++) {
      const c = client.clientHistory[f];
      const s = server.serverHistory[f];
      if (Math.abs(c.x - s.x) > 0.001 || Math.abs(c.y - s.y) > 0.001 || c.score !== s.score || c.coins !== s.coins) {
        diff = { frame: f, c, s };
        break;
      }
    }
    if (diff) {
      console.log(`Seed ${seed} Stage ${stage}: FAILED at frame ${diff.frame}. Client score=${client.game.score}, coins=${client.game.coins} vs Server score=${server.game.score}, coins=${server.game.coins}`);
    } else {
      console.log(`Seed ${seed} Stage ${stage}: PASSED! Score=${client.game.score}, Coins=${client.game.coins}`);
    }
  }
}

console.log('\n=== TEST 2: WITH FIX (allowDtZero = true) ===');
for (const stage of [1, 2, 3, 4]) {
  console.log(`\n--- Stage ${stage} ---`);
  for (let s = 1; s <= 5; s++) {
    const seed = 54321 + s * 1000 + stage * 50;
    const frames = [0];
    for (let f = 1; f < 300; f++) frames.push(0.95 + ((f * 17) % 11) * 0.01);
    const inputs = [
      { atFrame: 0, type: 'launch', dx: 25, dy: -70 },
      { atFrame: 40, type: 'launch', dx: -15, dy: -60 },
      { atFrame: 100, type: 'launch', dx: 30, dy: -80 },
      { atFrame: 180, type: 'launch', dx: -20, dy: -50 }
    ];

    const client = simulateClientRun({ seed, stage, inputs, frames });
    const server = simulateServerRun({ seed, stage, inputs, frames, allowDtZero: true });

    let diff = null;
    const minLen = Math.min(client.clientHistory.length, server.serverHistory.length);
    for (let f = 0; f < minLen; f++) {
      const c = client.clientHistory[f];
      const s = server.serverHistory[f];
      if (Math.abs(c.x - s.x) > 0.001 || Math.abs(c.y - s.y) > 0.001 || c.score !== s.score || c.coins !== s.coins) {
        diff = { frame: f, c, s };
        break;
      }
    }
    if (diff) {
      console.log(`Seed ${seed} Stage ${stage}: FAILED at frame ${diff.frame}. Client score=${client.game.score}, coins=${client.game.coins} vs Server score=${server.game.score}, coins=${server.game.coins}`);
    } else if (client.clientHistory.length !== server.serverHistory.length) {
      console.log(`Seed ${seed} Stage ${stage}: LENGTH MISMATCH: client=${client.clientHistory.length}, server=${server.serverHistory.length}`);
    } else {
      console.log(`Seed ${seed} Stage ${stage}: PERFECT MATCH! Score=${client.game.score}, Coins=${client.game.coins}, Frames=${client.clientHistory.length}`);
    }
  }
}
