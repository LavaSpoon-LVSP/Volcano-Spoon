import WebSocket from 'ws';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { User } from '../src/models/User.js';
import { RunResult } from '../src/models/RunResult.js';
import { replayRun } from '../src/game/ReplayEngine.js';
import { signAuthToken } from '../src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ── Safety guard ─────────────────────────────────────────────────────────
// This script WRITES to the database (grants energy/coins, creates runs) and
// talks to a running server. Refuse to run unless the target is clearly a
// local test database. Set TEST_MONGO_URI to a localhost URI (and optionally
// TEST_USERNAME) to run it.
const _testUri = process.env.TEST_MONGO_URI || ''
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(_testUri)) {
  console.error('Refusing to run: set TEST_MONGO_URI to a LOCAL mongodb URI (mongodb://localhost/... or 127.0.0.1). Never run this against a production database.')
  process.exit(1)
}
const TEST_USERNAME = process.env.TEST_USERNAME
if (!TEST_USERNAME) {
  console.error('Refusing to run: set TEST_USERNAME to the name of a test account on the LOCAL test database (no default is assumed).')
  process.exit(1)
}

const WS_URL = 'ws://localhost:5000/ws';

// Connect to MongoDB
await mongoose.connect(_testUri);
console.log('MongoDB connected for B1 Authoritative Test');

// Fetch the test user
const user = await User.findOne({ username: TEST_USERNAME });
if (!user) {
  console.error(`User ${TEST_USERNAME} not found`);
  process.exit(1);
}
console.log(`Initial state for ${user.username}: Coins=${user.coins}, XP=${user.totalXp}, JackpotTokens=${user.jackpotTokens}`);

// Helper to create a WebSocket connection and authenticate
function createAuthenticatedSession() {
  return new Promise((resolve, reject) => {
    const token = signAuthToken(user, process.env.JWT_SECRET);
    const ws = new WebSocket(`${WS_URL}?token=${token}`);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'game:start', perks: {}, isMobile: false }));
    });

    const activeWaiters = new Set();
    const history = [];

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log('WS MSG:', msg.type, msg.payload ? JSON.stringify(msg.payload).slice(0, 100) : '');
        // Notify any active waiter
        let handled = false;
        for (const waiter of activeWaiters) {
          if (waiter.filter(msg)) {
            activeWaiters.delete(waiter);
            clearTimeout(waiter.timer);
            waiter.resolve(msg);
            handled = true;
            break;
          }
        }
        if (!handled) {
          history.push(msg);
        }
      } catch (e) {
        console.error('Error parsing WS message:', e);
      }
    });

    function waitForMessage(filterFn, timeoutMs = 12000) {
      return new Promise((res, rej) => {
        const idx = history.findIndex(filterFn);
        if (idx !== -1) {
          const msg = history.splice(idx, 1)[0];
          return res(msg);
        }
        const waiter = {
          filter: filterFn,
          resolve: res,
          reject: rej,
          timer: setTimeout(() => {
            activeWaiters.delete(waiter);
            rej(new Error(`Timeout waiting for message matching filter after ${timeoutMs}ms`));
          }, timeoutMs),
        };
        activeWaiters.add(waiter);
      });
    }

    ws.on('error', reject);

    waitForMessage((m) => m.type === 'auth:ok' || m.type === 'game:state')
      .then(() => resolve({ ws, waitForMessage }))
      .catch(reject);
  });
}

// Function to find scoring inputs for any given seed
function findScoringRun(seed, stage = 1) {
  const frames = [0];
  for (let f = 1; f < 240; f++) frames.push(1);

  for (const angle of [35, 45, -35, -45, 25, 55, -25, -55, 65, -65]) {
    for (const p2 of [-40, 40, 0, -60, 60, -20, 20]) {
      for (const p3 of [30, -30, 50, -50, 0]) {
        const inputs = [
          { atFrame: 0, type: 'launch', dx: angle, dy: -75 },
          { atFrame: 45, type: 'launch', dx: p2, dy: -80 },
          { atFrame: 100, type: 'launch', dx: p3, dy: -70 },
          { atFrame: 160, type: 'launch', dx: -angle, dy: -85 },
        ];
        const r = replayRun({ seed, frames, inputs, arenaStage: stage, artifactPerks: {} });
        if (r.score > 0 && r.coins > 0) {
          return { frames, inputs, score: r.score, coins: r.coins, jackpotTokens: r.jackpotTokensCollected };
        }
      }
    }
  }
  // Fallback with 360 frames
  const longFrames = [0];
  for (let f = 1; f < 360; f++) longFrames.push(1);
  for (const angle of [35, -35, 45, -45]) {
    const inputs = [
      { atFrame: 0, type: 'launch', dx: angle, dy: -75 },
      { atFrame: 50, type: 'launch', dx: -angle, dy: -80 },
      { atFrame: 110, type: 'launch', dx: 30, dy: -70 },
      { atFrame: 180, type: 'launch', dx: -30, dy: -85 },
      { atFrame: 260, type: 'launch', dx: 25, dy: -75 },
    ];
    const r = replayRun({ seed, frames: longFrames, inputs, arenaStage: stage, artifactPerks: {} });
    if (r.score > 0 && r.coins > 0) {
      return { frames: longFrames, inputs, score: r.score, coins: r.coins, jackpotTokens: r.jackpotTokensCollected };
    }
  }
  return { frames, inputs: [{ atFrame: 0, type: 'launch', dx: 35, dy: -75 }], score: 1, coins: 1, jackpotTokens: 0 };
}

console.log('\n========================================================================');
console.log('  TEST 1: LIVE DUPLICATE RUN REPORT WITH SCORING RUN (SCORE & COINS > 0) ');
console.log('========================================================================\n');

const session1 = await createAuthenticatedSession();

// Start a run on Stage 1
session1.ws.send(JSON.stringify({ type: 'game:restart', isTutorial: false }));
const tokenMsg = await session1.waitForMessage((m) => m.type === 'run:token');
const { runToken, seed } = tokenMsg.payload;
console.log(`Run started with runToken: ${runToken}, seed: ${seed}`);

const scoringRun = findScoringRun(seed, 1);
console.log(`Scoring trajectory computed: Expected Score=${scoringRun.score}, Coins=${scoringRun.coins}`);

// Wait for real elapsed time so virtual duration check passes cleanly
const waitMs = Math.ceil(scoringRun.frames.length * 16.667 * 0.95);
console.log(`Simulating live gameplay duration (${waitMs}ms)...`);
await new Promise((resolve) => setTimeout(resolve, waitMs));

const runReport = {
  type: 'game:run_report',
  runToken,
  score: scoringRun.score,
  coinsEarned: scoringRun.coins,
  jackpotTokensCollected: scoringRun.jackpotTokens,
  durationMs: waitMs,
  frames: scoringRun.frames,
  inputs: scoringRun.inputs,
};

// Record balances before submit 1
const userBefore1 = await User.findById(user._id);
console.log(`Before Submit #1: Coins=${userBefore1.coins}, XP=${userBefore1.totalXp}`);

console.log('--> Sending SUBMIT #1 (first submission of scoring run)...');
session1.ws.send(JSON.stringify(runReport));

const response1Validated = await session1.waitForMessage((m) => m.type === 'run:validated');
console.log('\nResponse received for SUBMIT #1:');
console.log(JSON.stringify(response1Validated, null, 2));

const userAfter1 = await User.findById(user._id);
const coinsGained1 = userAfter1.coins - userBefore1.coins;
const xpGained1 = userAfter1.totalXp - userBefore1.totalXp;
console.log(`\nAfter SUBMIT #1 DB Verification:`);
console.log(`- Coins: ${userAfter1.coins} (Gained: +${coinsGained1}, Expected: +${scoringRun.coins})`);
console.log(`- XP:    ${userAfter1.totalXp} (Gained: +${xpGained1}, Expected: +${scoringRun.score})`);

const runRecord1 = await RunResult.findOne({ roundId: runToken });
console.log(`- RunResult in MongoDB: roundId=${runRecord1.roundId}, status=${runRecord1.status}, walletCredited=${runRecord1.walletCredited}, totalCoinsAfter=${runRecord1.totalCoinsAfter}`);

// Now send SUBMIT #2 (exact same payload, same runToken)
console.log('\n--> Sending SUBMIT #2 (byte-identical duplicate report, same runToken)...');
session1.ws.send(JSON.stringify(runReport));

const response2Validated = await session1.waitForMessage((m) => m.type === 'run:validated');
console.log('\nResponse received for SUBMIT #2:');
console.log(JSON.stringify(response2Validated, null, 2));

const userAfter2 = await User.findById(user._id);
const coinsGained2 = userAfter2.coins - userAfter1.coins;
const xpGained2 = userAfter2.totalXp - userAfter1.totalXp;
console.log(`\nAfter SUBMIT #2 DB Verification:`);
console.log(`- Coins: ${userAfter2.coins} (Duplicate gained: +${coinsGained2})`);
console.log(`- XP:    ${userAfter2.totalXp} (Duplicate gained: +${xpGained2})`);

const duplicatePass = (
  response1Validated.payload.roundId === response2Validated.payload.roundId &&
  response1Validated.payload.roundId === runToken &&
  response1Validated.payload.score === response2Validated.payload.score &&
  response1Validated.payload.coinsEarned === response2Validated.payload.coinsEarned &&
  coinsGained1 === scoringRun.coins &&
  coinsGained2 === 0 &&
  xpGained2 === 0 &&
  runRecord1.status === 'committed'
);

console.log(`\nDuplicate submission test result: ${duplicatePass ? 'PASSED (One result per round, no duplicate credits)' : 'FAILED'}`);

session1.ws.close();

console.log('\n========================================================================');
console.log('  TEST 2: FORCED FAILURE MID-SAVE (CRASH WHILE SETTLING) & RECOVERY     ');
console.log('========================================================================\n');

const session2 = await createAuthenticatedSession();
session2.ws.send(JSON.stringify({ type: 'game:restart', isTutorial: false }));
const tokenMsg2 = await session2.waitForMessage((m) => m.type === 'run:token');
const runToken2 = tokenMsg2.payload.runToken;
const seed2 = tokenMsg2.payload.seed;
console.log(`Run 2 started with runToken: ${runToken2}, seed: ${seed2}`);

const scoringRun2 = findScoringRun(seed2, 1);
console.log(`Run 2 scoring trajectory: Expected Score=${scoringRun2.score}, Coins=${scoringRun2.coins}`);

// Simulate mid-save crash state in MongoDB:
// A previous attempt got far enough to create the RunResult with status 'settling'
// but crashed before the wallet credit or status 'committed' could be saved.
await RunResult.create({
  roundId: runToken2,
  userId: user._id,
  status: 'settling',
  score: scoringRun2.score,
  coinsEarned: scoringRun2.coins,
  jackpotTokensCollected: scoringRun2.jackpotTokens,
  xpEarned: scoringRun2.score,
  arenaStage: 1,
  lavaCoinMultiplier: 1,
  walletCredited: false,
  totalCoinsAfter: null,
});

const midSaveRecord = await RunResult.findOne({ roundId: runToken2 });
console.log(`Mid-save state created in MongoDB:`);
console.log(`- roundId:        ${midSaveRecord.roundId}`);
console.log(`- status:         ${midSaveRecord.status} (interrupted before commit)`);
console.log(`- walletCredited: ${midSaveRecord.walletCredited}`);
console.log(`- totalCoinsAfter:${midSaveRecord.totalCoinsAfter}`);

const userBeforeRecover = await User.findById(user._id);
console.log(`\nUser balance before retry recovery: Coins=${userBeforeRecover.coins}, XP=${userBeforeRecover.totalXp}`);

// Client retries submission after crash / reconnect
const runReport2 = {
  type: 'game:run_report',
  runToken: runToken2,
  score: scoringRun2.score,
  coinsEarned: scoringRun2.coins,
  jackpotTokensCollected: scoringRun2.jackpotTokens,
  durationMs: 3000,
  frames: scoringRun2.frames,
  inputs: scoringRun2.inputs,
};

console.log('--> Sending retry report for round interrupted mid-save...');
session2.ws.send(JSON.stringify(runReport2));

const recoveryResponse = await session2.waitForMessage((m) => m.type === 'run:validated');
console.log('\nRecovery response received:');
console.log(JSON.stringify(recoveryResponse, null, 2));

const userAfterRecover = await User.findById(user._id);
const coinsRecovered = userAfterRecover.coins - userBeforeRecover.coins;
const xpRecovered = userAfterRecover.totalXp - userBeforeRecover.totalXp;
console.log(`\nAfter Recovery DB Verification:`);
console.log(`- Coins: ${userAfterRecover.coins} (Credited on recovery: +${coinsRecovered}, Expected: +${scoringRun2.coins})`);
console.log(`- XP:    ${userAfterRecover.totalXp} (Credited on recovery: +${xpRecovered}, Expected: +${scoringRun2.score})`);

const committedRecord = await RunResult.findOne({ roundId: runToken2 });
console.log(`- RunResult in MongoDB: roundId=${committedRecord.roundId}, status=${committedRecord.status}, walletCredited=${committedRecord.walletCredited}, totalCoinsAfter=${committedRecord.totalCoinsAfter}`);

// Send duplicate retry after recovery to ensure idempotency
console.log('\n--> Sending duplicate report after recovery...');
session2.ws.send(JSON.stringify(runReport2));
const dupRecoveryResponse = await session2.waitForMessage((m) => m.type === 'run:validated');

const userAfterDup = await User.findById(user._id);
const coinsAfterDup = userAfterDup.coins - userAfterRecover.coins;
console.log(`- User coins after duplicate: ${userAfterDup.coins} (Duplicate gained: +${coinsAfterDup})`);

const recoveryPass = (
  recoveryResponse.payload.roundId === runToken2 &&
  dupRecoveryResponse.payload.roundId === runToken2 &&
  coinsRecovered === scoringRun2.coins &&
  coinsAfterDup === 0 &&
  committedRecord.status === 'committed' &&
  committedRecord.walletCredited === true
);

console.log(`\nCrash-recovery test result: ${recoveryPass ? 'PASSED (Interrupted settlement safely recovered, exactly one credit, same round ID)' : 'FAILED'}`);

session2.ws.close();

const allB1Passed = duplicatePass && recoveryPass;
console.log('\n========================================================================');
console.log(`B1 VERIFICATION OVERALL: ${allB1Passed ? 'PASSED (All requirements verified)' : 'FAILED'}`);
console.log('========================================================================');

process.exit(allB1Passed ? 0 : 1);
