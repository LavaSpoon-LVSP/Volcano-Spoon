import 'dotenv/config'
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import { AdminUser } from '../src/models/AdminUser.js'

/**
 * One-time bootstrap for the first named admin account (see
 * src/models/AdminUser.js), for an environment that already has a real
 * admin relying on the OLD single shared ADMIN_PASSWORD scheme.
 *
 * server.js's POST /admin/login already has an automatic fallback for
 * this (if zero AdminUser documents exist, it accepts ADMIN_PASSWORD once
 * and creates the first 'owner' account from whatever username is sent
 * with that login) — this script is the same idea run from the command
 * line instead, for anyone who'd rather provision the first account
 * without touching the login form at all. Safe to run at any time: if an
 * admin account already exists, it does nothing rather than creating a
 * duplicate or overwriting anything.
 *
 * Usage (from Backend/):
 *   SEED_ADMIN_USERNAME=youradminname SEED_ADMIN_PASSWORD=yourpassword node scripts/seedAdminUser.mjs
 *
 * Both env vars are required; SEED_ADMIN_PASSWORD must be at least 8
 * characters, matching POST /api/admin/admins' own validation.
 */

const username = process.env.SEED_ADMIN_USERNAME
const password = process.env.SEED_ADMIN_PASSWORD

if (!username || !password) {
  console.error('Set SEED_ADMIN_USERNAME and SEED_ADMIN_PASSWORD in the environment before running this script.')
  process.exit(1)
}
if (password.length < 8) {
  console.error('SEED_ADMIN_PASSWORD must be at least 8 characters.')
  process.exit(1)
}
if (!process.env.MONGO_URI) {
  console.error('MONGO_URI is not set.')
  process.exit(1)
}

await mongoose.connect(process.env.MONGO_URI)

const alreadyExists = await AdminUser.exists({})
if (alreadyExists) {
  console.log('At least one admin account already exists — nothing to do. (Use POST /api/admin/admins as an existing owner to add more.)')
  await mongoose.disconnect()
  process.exit(0)
}

const passwordHash = await bcrypt.hash(password, 10)
const created = await AdminUser.create({ username: username.trim(), passwordHash, role: 'owner' })
console.log(`Created first admin account: "${created.username}" (role: owner). You can log in to the dashboard with it now.`)

await mongoose.disconnect()
process.exit(0)
