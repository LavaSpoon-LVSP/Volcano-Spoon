import 'dotenv/config'
import mongoose from 'mongoose'
import { User } from '../src/models/User.js'
import { AdminAuditLog } from '../src/models/AdminAuditLog.js'

/**
 * Finds players whose username has leading/trailing whitespace (e.g. "Omar ")
 * — signup used to store the raw value — and optionally renames them to the
 * trimmed value.
 *
 * Usage (from Backend/):
 *   node scripts/trimUsernames.mjs            # dry run: list only, changes nothing
 *   node scripts/trimUsernames.mjs --apply    # rename the safe ones
 *
 * A user is SKIPPED (reported as a conflict, needs manual review) when the
 * trimmed name already belongs to another account (case-insensitive) or the
 * trimmed name would be empty. AdminAuditLog.targetUsername is updated for
 * renamed users so history keeps matching.
 */
const apply = process.argv.includes('--apply')

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI is not set (check Backend/.env)')
  process.exit(1)
}

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 })

try {
  const candidates = await User.find({ username: /^\s|\s$/ }).select('_id username email')
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${candidates.length} user(s) with leading/trailing whitespace in username`)

  let renamed = 0
  const conflicts = []
  for (const user of candidates) {
    const trimmed = user.username.trim()
    const label = `${JSON.stringify(user.username)} -> ${JSON.stringify(trimmed)} (${user.email})`
    if (!trimmed) { conflicts.push(`${label} [empty after trim]`); continue }

    const clash = await User.findOne({
      _id: { $ne: user._id },
      username: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    }).select('_id')
    if (clash) { conflicts.push(`${label} [taken by another account]`); continue }

    console.log(`  ${apply ? 'renaming' : 'would rename'}: ${label}`)
    if (apply) {
      const oldName = user.username
      await User.updateOne({ _id: user._id }, { $set: { username: trimmed } })
      await AdminAuditLog.updateMany({ targetUserId: user._id }, { $set: { targetUsername: trimmed } })
      await AdminAuditLog.updateMany({ targetUserId: null, targetUsername: oldName }, { $set: { targetUsername: trimmed } })
      renamed += 1
    }
  }

  if (conflicts.length) {
    console.log('\nNeeds manual review (skipped):')
    conflicts.forEach((c) => console.log('  ' + c))
  }
  console.log(apply ? `\nRenamed ${renamed} user(s).` : '\nDry run only — re-run with --apply to rename.')
} finally {
  await mongoose.disconnect()
}
