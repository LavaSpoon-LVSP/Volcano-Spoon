// G2: admin login rate limit. Starts a SEPARATE backend on port 5056 using only .env.test (its own in-memory limiter,
// so your normal admin login on port 5000 is not locked out). Sends 12 wrong-password logins; writes nothing to the database.
// Run (from Backend/):  node scripts/test_g2_rate_limit.js
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5056, BASE = `http://127.0.0.1:${PORT}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const lines = []; const out = s => { console.log(s); lines.push(s) }
const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, DOTENV_CONFIG_PATH: '.env.test', PORT: String(PORT), NODE_ENV: 'test', ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'qa-g2-not-the-password' } })
let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d)
let up = false
for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(BASE + '/health')).ok } catch {} ; if (!up) await sleep(500) }
if (!up) { console.error('server did not start:\n' + log.slice(-800)); server.kill(); process.exit(1) }
out(`G2 admin login rate limit - ${new Date().toISOString()} - separate test server on port ${PORT}`)
const results = []
for (let i = 1; i <= 12; i++) {
  const r = await fetch(BASE + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa_nonexistent_admin', password: 'WrongPassword-' + i }) })
  let j = {}; try { j = await r.json() } catch {}
  results.push(r.status); out(`attempt ${String(i).padStart(2)}: HTTP ${r.status} ${JSON.stringify(j)}`)
}
server.kill()
const first429 = results.indexOf(429) + 1
const ok = results.slice(0, 10).every(s => s !== 429) && results.slice(10).every(s => s === 429)
out(`${ok ? '[PASS]' : '[FAIL]'} attempts 1-10 were processed by the login handler (not rate limited), attempts 11-12 answered 429 (rate limited); first 429 at attempt ${first429 || 'none'}`)
fs.writeFileSync(path.join(root, 'docs/evidence/test_g2_rate_limit.txt'), lines.join('\n') + '\n')
process.exit(ok ? 0 : 1)
