import 'dotenv/config'
import mongoose from 'mongoose'
import { Skin } from '../src/models/Skin.js'

/**
 * One-time seed script for the 24 named Spoon Skins (Volcanic Artifacts
 * page's new "Spoon Skins" section). Run manually with:
 *
 *   node scripts/seedSpoonSkins.js
 *
 * from `backend claude/backend claude/`. Safe to re-run — upserts by
 * spriteKey, so it will never create duplicates; running it again after
 * editing SKINS below (e.g. to tweak a price) updates the existing doc
 * in place instead of inserting a second one.
 *
 * There is no admin catalog UI for NFTs/Items either (see routes/nfts.js /
 * routes/items.js — both are only ever populated by hand or by a script
 * like this one), so this mirrors the existing project convention rather
 * than introducing a new one.
 *
 * Pricing (Lava Coins, tiered by rarity — user's explicit choice):
 *   common    = 300
 *   rare      = 700
 *   epic      = 1200
 *   legendary = 2000
 *
 * `image` paths point at the existing PNGs already in
 * frontendmain40/frontendmain40/public/images/ (confirmed present via
 * Glob before this script was written). `spriteKey` matches the keys
 * added to GameEngine.js's PLAYER_SPRITES map exactly.
 */

const PRICE_BY_RARITY = {
  common: 300,
  rare: 700,
  epic: 1200,
  legendary: 2000,
}

const SKINS = [
  { name: 'Thunderwhisper', spriteKey: 'thunderwhisper', file: 'Thunderwhisper.png', rarity: 'rare' },
  { name: 'Sandstrider', spriteKey: 'sandstrider', file: 'Sandstrider.png', rarity: 'common' },
  { name: 'Abyssal Echo', spriteKey: 'abyssal_echo', file: 'Abyssal_Echo.png', rarity: 'epic' },
  { name: 'Lunarlit', spriteKey: 'lunarlit', file: 'Lunarlit.png', rarity: 'rare' },
  { name: 'Venomglade', spriteKey: 'venomglade', file: 'Venomglade.png', rarity: 'common' },
  { name: 'Clockwork Caster', spriteKey: 'clockwork_caster', file: 'Clockwork_Caster.png', rarity: 'epic' },
  { name: 'Bloodmoon', spriteKey: 'bloodmoon', file: 'Bloodmoon.png', rarity: 'legendary' },
  { name: 'Starfall', spriteKey: 'starfall', file: 'Starfall.png', rarity: 'epic' },
  { name: 'Mossbound', spriteKey: 'mossbound', file: 'Mossbound.png', rarity: 'common' },
  { name: 'Dreamweaver', spriteKey: 'dreamweaver', file: 'Dreamweaver.png', rarity: 'rare' },
  { name: 'Necrotide', spriteKey: 'necrotide', file: 'Necrotide.png', rarity: 'epic' },
  { name: 'Aurorablade', spriteKey: 'aurorablade', file: 'Aurorablade.png', rarity: 'legendary' },
  { name: 'Stoneheart', spriteKey: 'stoneheart', file: 'Stoneheart.png', rarity: 'common' },
  { name: 'Sunforged', spriteKey: 'sunforged', file: 'Sunforged.png', rarity: 'rare' },
  { name: 'Spiritbloom', spriteKey: 'spiritbloom', file: 'Spiritbloom.png', rarity: 'common' },
  { name: 'Gravitywell', spriteKey: 'gravitywell', file: 'Gravitywell.png', rarity: 'epic' },
  { name: 'Serpentscale', spriteKey: 'serpentscale', file: 'Serpentscale.png', rarity: 'rare' },
  { name: 'Eclipse Edge', spriteKey: 'eclipse_edge', file: 'Eclipse_Edge.png', rarity: 'legendary' },
  { name: 'Soulhunter', spriteKey: 'soulhunter', file: 'Soulhunter.png', rarity: 'epic' },
  { name: 'Coral Reef', spriteKey: 'coral_reef', file: 'Coral_Reef.png', rarity: 'common' },
  { name: 'Glacierforge', spriteKey: 'glacierforge', file: 'Glacierforge.png', rarity: 'rare' },
  { name: 'Petalwind', spriteKey: 'petalwind', file: 'Petalwind.png', rarity: 'common' },
  { name: 'Runebound', spriteKey: 'runebound', file: 'Runebound.png', rarity: 'epic' },
  { name: 'Chromashift', spriteKey: 'chromashift', file: 'Chromashift.png', rarity: 'legendary' },
]

async function run() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — aborting seed.')
    process.exit(1)
  }

  await mongoose.connect(process.env.MONGO_URI)
  console.log('MongoDB connected — seeding Spoon Skins...')

  let created = 0
  let updated = 0

  for (const s of SKINS) {
    const price = PRICE_BY_RARITY[s.rarity]
    const doc = {
      name: s.name,
      description: `${s.name} — a ${s.rarity} Spoon Skin.`,
      price,
      rarity: s.rarity,
      image: `/images/${s.file}`,
      spriteKey: s.spriteKey,
    }

    const result = await Skin.findOneAndUpdate(
      { spriteKey: s.spriteKey },
      { $set: doc },
      { upsert: true, new: true, rawResult: true }
    )

    if (result.lastErrorObject?.upserted) {
      created++
      console.log(`  + created ${s.name} (${s.rarity}, ${price} coins)`)
    } else {
      updated++
      console.log(`  = updated ${s.name} (${s.rarity}, ${price} coins)`)
    }
  }

  console.log(`Done. ${created} created, ${updated} updated, ${SKINS.length} total.`)
  await mongoose.disconnect()
  process.exit(0)
}

run().catch((error) => {
  console.error('Seed failed:', error)
  process.exit(1)
})
