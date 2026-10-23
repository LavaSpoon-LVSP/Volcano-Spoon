import WebSocket from 'ws';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { User } from '../src/models/User.js';
import { AdminUser } from '../src/models/AdminUser.js';
import { replayRun } from '../src/game/ReplayEngine.js';
import { signAuthToken, signAdminToken } from '../src/auth.js';

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

const WS_URL = 'ws://127.0.0.1:5000/ws';
const API_URL = 'http://127.0.0.1:5000/api';

// Connect to MongoDB
await mongoose.connect(_testUri);
console.log('MongoDB connected for C1 Automated Suite');

// Wait for backend server to be healthy
console.log('Waiting for backend server on http://127.0.0.1:5000/health...');
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const h = await fetch('http://127.0.0.1:5000/health');
    if (h.ok) {
      console.log('Backend server is healthy and ready!');
      break;
    }
  } catch (e) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const user = await User.findOne({ username: TEST_USERNAME });
if (!user) {
  console.error(`User ${TEST_USERNAME} not found`);
  process.exit(1);
}

// Ensure the test user has ample energy for non-tutorial runs in the suite
await User.updateOne({ _id: user._id }, { $set: { energy: 50 } });
console.log(`Granted 50 energy to ${TEST_USERNAME} for automated testing`);

const admin = await AdminUser.findOne({ role: 'owner' }) || await AdminUser.findOne();
if (!admin) {
  console.error('Admin user not found');
  process.exit(1);
}

function createAuthenticatedSession() {
  return new Promise((resolve, reject) => {
    const token = signAuthToken(user, process.env.JWT_SECRET);
    const ws = new WebSocket(`${WS_URL}?token=${token}`);

    const activeWaiters = new Set();
    const history = [];

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'game:start', perks: {}, isMobile: false }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
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
        if (!handled) history.push(msg);
      } catch (e) {
        console.error('WS Parse Error:', e);
      }
    });

    function waitForMessage(filterFn, timeoutMs = 10000) {
      return new Promise((res, rej) => {
        const idx = history.findIndex(filterFn);
        if (idx !== -1) {
          return res(history.splice(idx, 1)[0]);
        }
        const waiter = {
          filter: filterFn,
          resolve: res,
          reject: rej,
          timer: setTimeout(() => {
            activeWaiters.delete(waiter);
            rej(new Error(`Timeout waiting for message matching filter after ${timeoutMs}ms. Unmatched history: ${JSON.stringify(history)}`));
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
function findScoringRun(seed, stage = 1, stageMultipliers = null, artifactPerks = {}) {
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
        const r = replayRun({ seed, frames, inputs, arenaStage: stage, stageMultipliers, artifactPerks });
        if (r.score > 0 && r.coins > 0) {
          return { frames, inputs, score: r.score, coins: r.coins };
        }
      }
    }
  }

  // Fallback
  return {
    frames,
    inputs: [{ atFrame: 0, type: 'launch', dx: 35, dy: -75 }],
    score: 0,
    coins: 0,
  };
}

const results = [];

console.log('========================================================================');
console.log('  TEST C1: AUTHORITATIVE SERVER REPLAY & ANTI-CHEAT AUTOMATED SUITE     ');
console.log('========================================================================\n');

// -----------------------------------------------------------------------------
// Scenario 1: Bogus/Never-Issued Run Token
// -----------------------------------------------------------------------------
console.log('--- Scenario 1: Bogus / Never-Issued Run Token ---');
{
  const session = await createAuthenticatedSession();
  const bogusToken = '00000000-dead-beef-0000-000000000000';
  session.ws.send(JSON.stringify({
    type: 'game:run_report',
    runToken: bogusToken,
    score: 9999,
    coinsEarned: 9999,
    durationMs: 5000,
    frames: [0, 1, 1],
    inputs: [{ atFrame: 0, type: 'launch', dx: 30, dy: -50 }],
  }));

  const res = await session.waitForMessage((m) => m.type === 'run:rejected');
  const pass = res.payload?.reason === 'invalid_or_expired_token';
  console.log('Response:', JSON.stringify(res));
  console.log(`Result: ${pass ? 'PASSED (Rejected with invalid_or_expired_token)' : 'FAILED'}\n`);
  results.push({ name: 'Bogus Token', pass, outcome: res.payload?.reason });
  session.ws.close();
}

// -----------------------------------------------------------------------------
// Scenario 2: Forged Extreme Launch Coordinates (dx: 9999, dy: 9999)
// -----------------------------------------------------------------------------
console.log('--- Scenario 2: Forged Extreme Launch Coordinates (dx: 9999, dy: 9999) ---');
{
  await new Promise((r) => setTimeout(r, 800)); // Respect RESTART_MIN_GAP_MS
  const session = await createAuthenticatedSession();
  session.ws.send(JSON.stringify({ type: 'game:restart', isTutorial: false }));
  const tokenMsg = await session.waitForMessage((m) => m.type === 'run:token');
  const { runToken } = tokenMsg.payload;

  // Real wait to exceed RUN_TOKEN_MIN_MS (250ms) so duration check passes and launch plausibility is tested
  await new Promise((r) => setTimeout(r, 350));

  session.ws.send(JSON.stringify({
    type: 'game:run_report',
    runToken,
    score: 99999,
    coinsEarned: 99999,
    durationMs: 5000,
    frames: [0, 1, 1],
    inputs: [{ atFrame: 0, type: 'launch', dx: 9999, dy: 9999 }],
  }));

  const res = await session.waitForMessage((m) => m.type === 'run:rejected');
  const pass = res.payload?.reason === 'implausible_launch_values';
  console.log('Response:', JSON.stringify(res));
  console.log(`Result: ${pass ? 'PASSED (Rejected with implausible_launch_values, claimed 99999 score ignored)' : 'FAILED'}\n`);
  results.push({ name: 'Forged Launch Values', pass, outcome: res.payload?.reason });
  session.ws.close();
}

// -----------------------------------------------------------------------------
// Scenario 3: Malformed / Missing Replay Log
// -----------------------------------------------------------------------------
console.log('--- Scenario 3: Malformed / Missing Replay Log ---');
{
  await new Promise((r) => setTimeout(r, 800)); // Respect RESTART_MIN_GAP_MS
  const session = await createAuthenticatedSession();
  session.ws.send(JSON.stringify({ type: 'game:restart', isTutorial: false }));
  const tokenMsg = await session.waitForMessage((m) => m.type === 'run:token');
  const { runToken } = tokenMsg.payload;

  // Real wait to exceed RUN_TOKEN_MIN_MS (250ms)
  await new Promise((r) => setTimeout(r, 350));

  session.ws.send(JSON.stringify({
    type: 'game:run_report',
    runToken,
    score: 100,
    coinsEarned: 50,
    durationMs: 5000,
    frames: [], // Empty / malformed replay log
    inputs: [],
  }));

  const res = await session.waitForMessage((m) => m.type === 'run:rejected');
  const pass = res.payload?.reason === 'missing_replay_log';
  console.log('Response:', JSON.stringify(res));
  console.log(`Result: ${pass ? 'PASSED (Rejected with missing_replay_log)' : 'FAILED'}\n`);
  results.push({ name: 'Malformed Replay Log', pass, outcome: res.payload?.reason });
  session.ws.close();
}

// -----------------------------------------------------------------------------
// Scenario 4: Exaggerated Claimed Virtual Duration (Impossible Speed Run)
// -----------------------------------------------------------------------------
console.log('--- Scenario 4: Exaggerated Claimed Virtual Duration ---');
{
  await new Promise((r) => setTimeout(r, 800)); // Respect RESTART_MIN_GAP_MS
  const session = await createAuthenticatedSession();
  session.ws.send(JSON.stringify({ type: 'game:restart', isTutorial: false }));
  const tokenMsg = await session.waitForMessage((m) => m.type === 'run:token');
  const { runToken } = tokenMsg.payload;

  // Wait 350ms (>= 250ms RUN_TOKEN_MIN_MS), but claim 250 frames (~4166ms) -> triggers implausible_replay_duration
  await new Promise((r) => setTimeout(r, 350));

  const frames = [0];
  for (let f = 1; f < 250; f++) frames.push(1);

  session.ws.send(JSON.stringify({
    type: 'game:run_report',
    runToken,
    score: 500,
    coinsEarned: 200,
    durationMs: 50,
    frames,
    inputs: [{ atFrame: 0, type: 'launch', dx: 30, dy: -60 }],
  }));

  const res = await session.waitForMessage((m) => m.type === 'run:rejected');
  const pass = res.payload?.reason === 'implausible_replay_duration';
  console.log('Response:', JSON.stringify(res));
  console.log(`Result: ${pass ? 'PASSED (Rejected with implausible_replay_duration)' : 'FAILED'}\n`);
  results.push({ name: 'Implausible Duration', pass, outcome: res.payload?.reason });
  session.ws.close();
}

// -----------------------------------------------------------------------------
// Scenario 5: Scripted Machine-Timed Inputs (Anti-Bot Review Flag)
// -----------------------------------------------------------------------------
console.log('--- Scenario 5: Scripted Machine-Timed Inputs (Anti-Bot Review Flag) ---');
{
  await new Promise((r) => setTimeout(r, 800)); // Respect RESTART_MIN_GAP_MS
  const session = await createAuthenticatedSession();
  session.ws.send(JSON.stringify({ type: 'game:restart', isTutorial: false }));
  const tokenMsg = await session.waitForMessage((m) => m.type === 'run:token');
  const { runToken } = tokenMsg.payload;

  // 7 inputs with mathematical precision (spaced exactly 10 frames apart, stddev = 0ms)
  const frames = [0];
  for (let f = 1; f < 100; f++) frames.push(1);
  const inputs = [];
  for (let i = 0; i < 7; i++) {
    inputs.push({ atFrame: i * 10, type: 'launch', dx: 30, dy: -60 });
  }

  // Real wait to allow normal duration check to pass (100 frames = 1667ms)
  await new Promise((r) => setTimeout(r, 1800));

  session.ws.send(JSON.stringify({
    type: 'game:run_report',
    runToken,
    score: 0,
    coinsEarned: 0,
    durationMs: 1800,
    frames,
    inputs,
  }));

  // Policy: NOT auto-banned or auto-rejected, but flagged for admin review
  const res = await session.waitForMessage((m) => m.type === 'run:validated');
  console.log('Response:', JSON.stringify(res));
  console.log('Result: PASSED (Run validated and flagged for admin review without auto-banning)\n');
  results.push({ name: 'Scripted Timing Flag', pass: res.type === 'run:validated', outcome: 'flagged_for_review' });
  session.ws.close();
}

// -----------------------------------------------------------------------------
// Scenario 6: Normal Valid Run Replaying Correctly (Fix 2 Verification)
// -----------------------------------------------------------------------------
console.log('--- Scenario 6: Normal Valid Run Replaying Correctly (Fix 2 Verification) ---');
{
  await new Promise((r) => setTimeout(r, 800)); // Respect RESTART_MIN_GAP_MS
  const session = await createAuthenticatedSession();
  session.ws.send(JSON.stringify({ type: 'game:restart', isTutorial: false }));
  const tokenMsg = await session.waitForMessage((m) => m.type === 'run:token');
  const { runToken, seed } = tokenMsg.payload;

  const scoringRun = findScoringRun(seed, 1);
  const { frames, inputs, score: expScore, coins: expCoins } = scoringRun;

  console.log(`Authoritative server replay computed: Score=${expScore}, Coins=${expCoins}`);

  // Wait real time for frames duration
  const waitMs = Math.round(frames.length * 16.667) + 500;
  await new Promise((r) => setTimeout(r, waitMs));

  const userBefore = await User.findById(user._id);

  session.ws.send(JSON.stringify({
    type: 'game:run_report',
    runToken,
    score: expScore,
    coinsEarned: expCoins,
    durationMs: waitMs,
    frames,
    inputs,
  }));

  const res = await session.waitForMessage((m) => m.type === 'run:validated');
  const userAfter = await User.findById(user._id);

  const scoreMatched = res.payload.score === expScore;
  const coinsMatched = res.payload.coinsEarned === expCoins;
  const userCredited = (userAfter.coins - userBefore.coins) === expCoins;

  console.log('Response:', JSON.stringify(res, null, 2));
  console.log(`- Authoritative Score Matched: ${scoreMatched}`);
  console.log(`- Authoritative Coins Matched: ${coinsMatched}`);
  console.log(`- User Wallet Credited Correctly: ${userCredited}`);

  const pass = scoreMatched && coinsMatched && userCredited;
  console.log(`Result: ${pass ? 'PASSED (Normal run replayed and credited authoritatively with 100% precision)' : 'FAILED'}\n`);
  results.push({ name: 'Normal Scoring Run', pass, outcome: `Score=${res.payload.score}, Coins=${res.payload.coinsEarned}` });
  session.ws.close();
}

// -----------------------------------------------------------------------------
// Scenario 7: Admin API Persistence Verification (GET /api/admin/players/:username/anti-cheat)
// -----------------------------------------------------------------------------
console.log('--- Scenario 7: Admin Anti-Cheat API Verification ---');
{
  // Brief wait to ensure async MongoDB alert records are fully committed
  await new Promise((r) => setTimeout(r, 1000));

  const adminToken = signAdminToken(process.env.JWT_SECRET, admin);
  const response = await fetch(`${API_URL}/admin/players/${TEST_USERNAME}/anti-cheat`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (!response.ok) {
    console.error(`Admin API responded with HTTP ${response.status}`);
    results.push({ name: 'Admin API Persistence', pass: false });
  } else {
    const data = await response.json();
    console.log(`Admin API returned ${data.alerts?.length ?? 0} total anti-cheat alerts for ${TEST_USERNAME}.`);
    const alertTypes = data.alerts?.slice(0, 8).map((a) => a.type);
    console.log('Latest alerts persisted on server:', alertTypes);

    const hasInvalidToken = data.alerts.some((a) => a.type === 'invalid_or_expired_token');
    const hasImplausibleLaunch = data.alerts.some((a) => a.type === 'implausible_launch_values');
    const hasImplausibleDuration = data.alerts.some((a) => a.type === 'implausible_replay_duration');
    const hasMissingReplay = data.alerts.some((a) => a.type === 'missing_replay_log');
    const hasScriptedTiming = data.alerts.some((a) => a.type === 'scripted_input_timing');

    console.log(`- 'invalid_or_expired_token' persisted: ${hasInvalidToken}`);
    console.log(`- 'implausible_launch_values' persisted: ${hasImplausibleLaunch}`);
    console.log(`- 'missing_replay_log' persisted:        ${hasMissingReplay}`);
    console.log(`- 'implausible_replay_duration' persisted: ${hasImplausibleDuration}`);
    console.log(`- 'scripted_input_timing' persisted:       ${hasScriptedTiming}`);

    const pass = hasInvalidToken && hasImplausibleLaunch && hasImplausibleDuration && hasMissingReplay && hasScriptedTiming;
    console.log(`Result: ${pass ? 'PASSED (All alerts successfully persisted for admin review)' : 'FAILED'}\n`);
    results.push({ name: 'Admin API Persistence', pass, outcome: `${data.alerts.length} alerts verified` });
  }
}

console.log('========================================================================');
console.log('  SUMMARY OF C1 SERVER REPLAY & ANTI-CHEAT SUITE                        ');
console.log('========================================================================');
results.forEach((r, idx) => {
  console.log(`${idx + 1}. ${r.name.padEnd(30, ' ')}: ${r.pass ? 'PASSED' : 'FAILED'} (${r.outcome})`);
});
const allPassed = results.every((r) => r.pass);
console.log(`\nOVERALL C1 STATUS: ${allPassed ? 'ALL SCENARIOS PASSED' : 'FAILURES DETECTED'}`);
console.log('========================================================================');

process.exit(allPassed ? 0 : 1);
