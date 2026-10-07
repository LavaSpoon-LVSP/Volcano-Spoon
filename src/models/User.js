import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
{
  username: {
    type: String,
    required: true,
    unique: true,
  },

  email: {
    type: String,
    required: true,
    unique: true,
  },

  passwordHash: {
    type: String,
    required: true,
  },

  // Bumped by a successful password reset (see routes/auth.js's
  // POST /auth/reset-password) to invalidate every JWT issued before the
  // reset — auth tokens are stateless (signAuthToken embeds the
  // tokenVersion at issue time; requireAuth/the WebSocket handshake both
  // reject a token whose tokenVersion doesn't match the User doc's
  // current value), so this is what "end existing sessions after a
  // reset" means for this app: there's no server-side session store to
  // clear, just this counter every future auth check compares against.
  tokenVersion: {
    type: Number,
    default: 0,
  },

  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },

  coins: {
    type: Number,
    default: 0,
  },

  // LSVP Token balance — credited by the Lava Coin -> LSVP Token cash-out
  // feature (see src/routes/cashout.js). Kept separate from `coins` (Lava
  // Coins), which is the wallet spent/earned by existing gameplay.
  lsvpBalance: {
    type: Number,
    default: 0,
  },

  // Server-side NFT inventory — populated when an NFT is awarded (e.g. jackpot reward)
  // or purchased (see routes/nfts.js). Stores Nft _id strings. Validated against
  // marketplace on award/purchase to prevent dupes.
  ownedNftIds: {
    type: [String],
    default: [],
  },

  // Which of the owned NFTs are currently "active" (i.e. their cosmetic/perk
  // effect is switched on) — a subset of ownedNftIds. Server-side so the same
  // active/inactive set is seen on every device, not just whichever browser
  // last toggled it. Every NFT is added here automatically the moment it's
  // granted (purchase or award), so it's active from the start; the player
  // can flip it off/on afterward from the Profile page (see PATCH
  // /api/nfts/:id/active).
  activeNftIds: {
    type: [String],
    default: [],
  },

  // Set once activeNftIds has been backfilled for a user who owned NFTs
  // before the active/inactive feature existed (so their existing NFTs get
  // marked active exactly once, instead of silently defaulting to
  // "inactive" — see ensureActiveNftIdsInitialized in routes/nfts.js). Not
  // meant to be read/written anywhere else.
  nftActiveInitialized: {
    type: Boolean,
    default: false,
  },

  // ── Arena Stages progression (additive — see src/game/arenaStages.js,
  // src/routes/arenaStages.js) ──
  // Every stage number the user has unlocked. Every new user starts with
  // just Stage 1; Stages 2-8 are unlocked sequentially by spending Lava
  // Coins (see POST /api/arena-stages/unlock).
  unlockedArenaStages: {
    type: [Number],
    default: [1],
  },

  // Which unlocked stage is currently selected/active for this user's next
  // game session (see POST /api/arena-stages/select and ClientSession.refresh()).
  currentArenaStage: {
    type: Number,
    default: 1,
  },

  // ── Spoon Skins (additive — see src/models/Skin.js, src/routes/skins.js) ──
  // Server-side skin inventory — populated when a Spoon Skin is purchased.
  // Stores Skin _id strings, same convention as ownedNftIds.
  ownedSkinIds: {
    type: [String],
    default: [],
  },

  // Which single owned skin is the player's equipped default spoon look —
  // stored as the Skin's `spriteKey` slug (e.g. 'thunderwhisper'), NOT its
  // Mongo _id, because that's what GameLogic._resolvePlayerSkin returns and
  // GameEngine.js's PLAYER_SPRITES map is keyed on (see routes/skins.js's
  // POST /:id/equip for where the id→spriteKey resolution happens). Unlike
  // NFTs (many active at once), skins are single-select — only one can be
  // equipped at a time. null means "use the built-in default spoon" (Lava
  // spoon.png). Does NOT affect the existing orb-pickup-driven temporary
  // skin swap in GameLogic._resolvePlayerSkin — it only changes what that
  // method falls back to when no temporary swap is active.
  equippedSkinId: {
    type: String,
    default: null,
  },

  // ── Purchasable Jackpot Orb feature (additive — see
  // src/models/JackpotConfig.js, src/routes/jackpot.js) ──
  // This is a SEPARATE inventory from the existing natural in-game Jackpot
  // Orb spawn/reward — buying/using one of these never touches the natural
  // spawn system. Number of Jackpot Orbs this user has purchased (with
  // LSVP) but not yet used/consumed.
  jackpotOrbs: {
    type: Number,
    default: 0,
    min: 0,
  },

  // Cosmetic items won from a Jackpot Orb draw (see JackpotConfig.js's
  // rewards.cosmetic pool). Stores cosmetic `id` strings — future-proof
  // storage ahead of actual cosmetic rendering/effects being built.
  ownedCosmeticIds: {
    type: [String],
    default: [],
  },

  // ── Persistent XP system (additive — see src/game/xpLeveling.js,
  // src/routes/xp.js, ClientSession.saveXp()) ──
  // Permanently accumulated across every completed game (tutorial runs
  // never contribute — same rule as coins/bestScore). Never reset except
  // by explicit admin action; XP earned per game is currently defined as
  // that game's final score (see ClientSession.saveXp()).
  totalXp: {
    type: Number,
    default: 0,
    min: 0,
  },

  // Server timestamp of the last time totalXp was incremented — surfaced
  // on the profile alongside the total itself.
  lastXpUpdate: {
    type: Date,
    default: null,
  },

  // ── Jackpot Tokens (additive — see src/game/GameLogic.js's 'jackpot'
  // orb-collision case, ClientSession.saveJackpotTokens(),
  // src/routes/slotMachine.js) ──
  // Permanently accumulated: +1 every time the player collects a natural
  // in-game Jackpot Orb (tutorial runs never contribute, same rule as
  // coins/XP/bestScore). Spent on Jackpot Slot Machine spins — completely
  // separate currency from `jackpotOrbs` above (which is a purchasable,
  // LSVP-bought inventory item, not something earned by collecting orbs).
  jackpotTokens: {
    type: Number,
    default: 0,
    min: 0,
  },

  // ── Badges / Achievements (additive — migrated off browser-only
  // localStorage, see src/routes/badges.js, frontend Game.jsx/
  // ProfilePanel.jsx) ──
  // A badge is detected client-side (same trusted-client pattern already
  // used for tutorial-flow events like tutorial_orb_collected) and reported
  // to POST /api/badges/earn to be centrally recorded here, so it shows up
  // on any device/browser the player logs into instead of being stuck in
  // one browser's localStorage. Not tied to any coin/XP/NFT payout, so this
  // intentionally does not need the heavier replay-validated anti-cheat
  // treatment those get — worst case of a bad report is a cosmetic badge
  // showing early/incorrectly, not an economy exploit.
  badges: {
    type: [
      {
        _id: false,
        id: { type: String, required: true },
        earnedAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },

  // ── Daily Energy System (additive — see src/models/EnergyConfig.js,
  // src/game/EnergyService.js, src/routes/energy.js) ──
  // Limits how many game runs a player can start per day, to protect the
  // Lava Coin economy from farming. Every new user starts with a full tank
  // (see EnergyConfig's maxEnergy default of 10) — the default below is a
  // fallback only; EnergyService always settles against the live admin
  // config on read, so this default doesn't need to track config changes.
  energy: {
    type: Number,
    default: 10,
    min: 0,
  },

  // Timestamp regen ticks are measured from. Advanced forward (not reset to
  // "now") each time regen ticks are applied, so partial progress toward
  // the next +1 tick is never lost — see EnergyService.settleUserEnergy().
  energyLastRegenAt: {
    type: Date,
    default: Date.now,
  },

  // Last time this user's energy was reset to full by the daily reset (see
  // EnergyConfig.dailyResetTimezone). Compared against "today" in the
  // configured timezone, not a raw 24h timer, so the reset always lands at
  // local midnight regardless of when the player last played.
  energyLastDailyResetAt: {
    type: Date,
    default: Date.now,
  },

  // Set when the player buys the "Unlimited Energy (1 Hour)" option (see
  // routes/energy.js POST /purchase). While now < unlimitedEnergyUntil, game
  // runs never consume energy. null/past = inactive.
  unlimitedEnergyUntil: {
    type: Date,
    default: null,
  },

  // ── Solana wallet (additive — see src/routes/blockchainUser.js,
  // src/solana/*) ──
  // The player's own Solana wallet address (Phantom/Solflare, connected via
  // the frontend's wallet-adapter). Purchased LSVP Tokens and NFTs are sent
  // here from the admin wallet — the backend never holds a private key for
  // this address, only the player's own wallet extension can spend from it.
  // Same address is used whether SOLANA_NETWORK is devnet or mainnet-beta;
  // only which network it's checked against changes (see config/solana.js).
  solanaWalletAddress: {
    type: String,
    // No `default: null` here on purpose: Mongoose would then write an
    // explicit `null` into every new user document, and a sparse index
    // only skips documents where the field is completely ABSENT — a
    // present-but-null field still counts as a value, so every
    // no-wallet-yet signup after the first collided on the unique index
    // (E11000 dup key: { solanaWalletAddress: null }). Leaving the field
    // unset until a real address is linked keeps it genuinely absent, so
    // the sparse+unique index only applies to real linked addresses.
    unique: true,
    sparse: true,
  },
},
{
  timestamps: true,
}
)

export const User = mongoose.model('User', userSchema)
