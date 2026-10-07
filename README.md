# Volcano Spoon — Backend

Node/Express + WebSocket backend for Volcano Spoon: player auth, the
real-time game session (WebSocket at `/ws`), Mongo-backed persistence, and
the Solana-based LSVP/NFT/Skins economy.

## Project structure (quick orientation)

```
server.js              HTTP + WebSocket entry point, CORS, routes, WS upgrade/auth
mongo.js                Mongo connection
src/
  auth.js               JWT sign/verify (player + admin tokens)
  middleware/            requireAuth / requireAdmin
  routes/                One file per REST feature (nfts, skins, cashout, jackpot,
                          items, slotMachine, energy, arenaStages, seasons, xp,
                          blockchainUser, blockchainAdmin)
  game/                  The game engine + WebSocket session logic (ClientSession.js,
                          GameLogic.js, ReplayEngine.js, EnergyService.js, ...)
  models/                Mongoose schemas
  solana/                On-chain payment verification, token transfers, NFT scanning
  config/solana.js       Single source of truth for devnet/mainnet network config
scripts/                 One-off/admin scripts (see "Scripts" below)
```

## Prerequisites

- Node.js 18+ and npm
- A MongoDB connection string (a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster works)
- A Solana wallet to act as the **admin wallet** (holds NFTs before sale,
  pays out LSVP purchases/refunds) — a Phantom or Solflare wallet works;
  you'll need its base58 secret key
- The LSVP token's on-chain mint address for whichever network you're
  targeting (devnet or mainnet-beta)

## Quickstart checklist

1. [ ] `npm install`
2. [ ] `cp .env.example .env`
3. [ ] Fill in `MONGO_URI`, `JWT_SECRET`, `ADMIN_PASSWORD` (see below)
4. [ ] Fill in `SOLANA_NETWORK` (`devnet` while developing)
5. [ ] Fill in `LSVP_TOKEN_MINT_DEVNET` (or `_MAINNET`) for that network
6. [ ] Fill in `ADMIN_WALLET_SECRET_KEY`
7. [ ] `npm run build` (sanity-checks imports)
8. [ ] `npm run dev`
9. [ ] Add your frontend's dev URL to the CORS allowlist in `server.js` if it isn't already there (see "CORS" below)

## Environment variables

Copy `.env.example` to `.env` and fill in every value below.

### Server

| Variable | Required | Notes |
|---|---|---|
| `PORT` | No | Defaults to `3000` if unset. The HTTP API and the WebSocket server (`/ws`) share this one port. |

### Database

| Variable | Required | Notes |
|---|---|---|
| `MONGO_URI` | **Yes** | Full MongoDB connection string, e.g. `mongodb+srv://user:pass@cluster.mongodb.net/dbname`. Logged as an error on boot if missing, and the process exits if the connection itself fails. |

**How to get a `MONGO_URI` (MongoDB Atlas, free tier):**
1. Create an account at [mongodb.com/atlas](https://www.mongodb.com/atlas) and create a free (M0) cluster.
2. Under **Database Access**, create a database user with a username/password.
3. Under **Network Access**, add your server's IP (or `0.0.0.0/0` for "allow from anywhere" during local dev — tighten this for production).
4. Click **Connect** on your cluster → **Drivers** → copy the connection string, then replace `<username>`/`<password>` with the user you created and add a database name at the end (e.g. `.../volcanospoon?retryWrites=true...`).

### Auth

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | **Yes** | Signs/verifies every player auth token *and* the admin-dashboard token. |
| `ADMIN_PASSWORD` | **Yes** (for admin dashboard) | A single shared password for `POST /admin/login` — not tied to any player account. Compared with a constant-time check (`crypto.timingSafeEqual`) so it can't be timed to leak. |

**How to get a `JWT_SECRET`:** generate a long random string — don't type one by hand.
```
openssl rand -hex 32
```
(or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` if you don't have `openssl`). Never reuse a dev secret in production, and never commit it.

**How to pick `ADMIN_PASSWORD`:** any long, random string you don't reuse elsewhere — this is the only thing standing between the public internet and `/admin/login`. `/admin/login` is also rate-limited (10 attempts / 15 min / IP) — see server.js's `adminLoginLimiter`.

### CORS & networking

| Variable | Required | Notes |
|---|---|---|
| `CORS_ORIGINS` | No | Comma-separated list of allowed frontend origins, e.g. `http://localhost:5173,https://mygame.example.com`. If unset, falls back to a hardcoded default list in `server.js` — set this explicitly so a new staging/production frontend URL doesn't need a code change + redeploy to work. This is also the most likely cause of a working password/admin login suddenly failing after a frontend redeploy to a new URL: the browser blocks the request as cross-origin before the server ever sees it. |
| `TRUST_PROXY` | No | Set to `1` if this deploys behind exactly one reverse proxy (hPanel/Railway/nginx/etc. — the normal case) so rate limiting and `req.ip` see the real client IP via `X-Forwarded-For` instead of the proxy's own address. Leave unset if this process is directly exposed to the internet with no proxy in front. |

### Password reset emails

| Variable | Required | Notes |
|---|---|---|
| `FRONTEND_URL` | No (defaults to `http://localhost:5173`) | Origin the `POST /auth/forgot-password` reset link points at — wherever the frontend's reset-password page is served from. |
| `MAIL_TRANSPORT` | No (defaults to `console`) | `smtp` for real delivery, `console` to just log the email instead of sending it (useful for local dev with no mail server configured), `none` to drop it silently. See `src/mail/mailer.js`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | Only if `MAIL_TRANSPORT=smtp` | Standard SMTP connection settings, passed straight to `nodemailer.createTransport`. |
| `MAIL_FROM` | Only if `MAIL_TRANSPORT=smtp` | The `From:` address on outgoing reset emails. |

### Solana network selection

| Variable | Required | Notes |
|---|---|---|
| `SOLANA_NETWORK` | No | `devnet` or `mainnet-beta`. Anything else (including unset) falls back to `devnet` with a warning logged on boot. This one variable decides which of the RPC/WS/mint variables below actually get read — set it *before* filling in the network-specific ones. |

### Solana RPC / WebSocket endpoints (optional overrides)

Leave these blank to use Solana's default public cluster endpoints — fine
for light development. Set them if you're using a third-party RPC provider
(Helius, QuickNode, Alchemy, etc.) or hitting the public endpoints' rate
limits.

| Variable | Required | Notes |
|---|---|---|
| `SOLANA_RPC_URL_DEVNET` | No | Overrides the default devnet RPC endpoint. |
| `SOLANA_RPC_URL_MAINNET` | No | Overrides the default mainnet-beta RPC endpoint. |
| `SOLANA_WS_URL_DEVNET` | No | Overrides the WebSocket endpoint used to wait for transaction confirmations on devnet. Set this if your RPC provider's HTTP endpoint works fine but its WS endpoint doesn't support `signatureSubscribe` — otherwise every transfer's confirmation step hangs retrying it, which can stall long enough for a second transaction's blockhash to expire before it's even sent. |
| `SOLANA_WS_URL_MAINNET` | No | Same as above, for mainnet-beta. |

**Where to get a provider RPC/WS URL:** sign up at [helius.dev](https://www.helius.dev), [quicknode.com](https://www.quicknode.com), or similar — free tiers exist for both devnet and mainnet.

### LSVP token mint addresses

| Variable | Required | Notes |
|---|---|---|
| `LSVP_TOKEN_MINT_DEVNET` | Required if `SOLANA_NETWORK=devnet` | The LSVP SPL token's mint address on devnet. |
| `LSVP_TOKEN_MINT_MAINNET` | Required if `SOLANA_NETWORK=mainnet-beta` | The LSVP SPL token's mint address on mainnet-beta. |

A mint only exists on one network at a time — a devnet LSVP mint and a
mainnet LSVP mint are two entirely different tokens. Without the matching
one set, LSVP purchases and NFT/skin/item payments fail on that network
(the server logs exactly which one is missing on boot).

**Where to get this:** if LSVP already exists, get the mint address from
whoever created it. To create a brand-new test token on devnet yourself
(via the [Solana CLI](https://docs.solanalabs.com/cli/install) + `spl-token`):
```
solana config set --url devnet
spl-token create-token          # prints the new mint address
```

### Admin wallet

| Variable | Required | Notes |
|---|---|---|
| `ADMIN_WALLET_SECRET_KEY` | **Yes** (for any blockchain route) | Base58-encoded secret key for the admin wallet. |

**How to get this:** open Phantom or Solflare → the wallet you want to use
as admin → Settings → **Export Private Key** → copy the base58 string it
shows you. This wallet needs:
- A small amount of SOL for transaction fees (devnet: use a faucet, e.g. `solana airdrop 1 --url devnet`)
- Whatever LSVP/NFTs it needs to be able to pay out or sell

The same keypair works on both networks (a Solana address doesn't change
per-network) — only its *funds* differ, so fund it separately on whichever
network `SOLANA_NETWORK` points at.

> **⚠️ Security:** this key can move every token/NFT the admin wallet
> holds. Never commit it, never log it, never send it to the frontend, and
> keep it out of `.env` on any machine other than the server itself. If it
> ever leaks, move funds to a new wallet and rotate immediately.

## Running the app

```
npm run build     # sanity-check: imports every core gameplay module,
                   # exits non-zero on any import/syntax error — run this
                   # before deploying
npm run dev        # node --watch server.js — auto-restarts on file changes
npm start          # plain node server.js
npm run seed:skins # one-time seed of the 24 named Spoon Skins (safe to re-run)
```

On success you'll see `HTTP + WS server listening on :<PORT>`.

## CORS

Allowed frontend origins are a hardcoded array in `server.js`'s
`cors({ origin: [...] })` call. If you're running the frontend locally on a
port not already in that list (Vite's default is `http://localhost:5173`,
but it auto-increments if that port is busy), add your dev URL to that
array or requests from the browser will be silently blocked.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `MONGO_URI is not set` on boot | `.env` missing/not loaded, or the variable name is misspelled |
| `JWT_SECRET is not set` on boot | Same — auth will fail even if the server otherwise starts |
| Every request gets `401 Invalid or expired token` | `JWT_SECRET` changed since the token was issued — sign in again |
| `ADMIN_WALLET_SECRET_KEY is not set — blockchain routes will fail` | Set it, or expect every LSVP/NFT/skin/item purchase route to fail |
| `LSVP token mint is not set for network "..."` | Set the mint variable matching your current `SOLANA_NETWORK` |
| Frontend requests are blocked / no `Access-Control-Allow-Origin` | Add the frontend's exact origin to `server.js`'s CORS `origin` array |
| WebSocket closes immediately with code 4001 | Missing/invalid/expired auth token on the `/ws?token=...` connection |

## Notes

- Player-facing routes are documented inline at the top of each file under
  `src/routes/` (what each endpoint does, whether it's public/auth/admin).
- `scripts/debugNftImage.js <collectionMintAddress>` is a one-off diagnostic
  for "why isn't this NFT collection's image showing" — uses the exact same
  resolution logic the real sync does.
