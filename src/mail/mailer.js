import nodemailer from 'nodemailer'

/**
 * Pluggable mail transport, selected entirely through environment
 * settings (MAIL_TRANSPORT) rather than a code change — see .env.example
 * for every variable this reads.
 *
 *   MAIL_TRANSPORT=smtp     → real delivery via nodemailer's SMTP
 *                              transport (SMTP_HOST/PORT/SECURE/USER/PASS,
 *                              MAIL_FROM).
 *   MAIL_TRANSPORT=console  → logs the message instead of sending it.
 *                              This is the default when MAIL_TRANSPORT
 *                              isn't set at all, so password-reset works
 *                              out of the box in local dev without any
 *                              mail server configured — the reset link
 *                              just shows up in the server's own console.
 *   MAIL_TRANSPORT=none     → silently drops the message (e.g. for a test
 *                              environment that wants zero mail I/O and
 *                              doesn't care about seeing the link).
 *
 * Callers (see routes/auth.js) must NEVER let whether sendMail() actually
 * succeeded change what's sent back to the client — the forgot-password
 * endpoint's response has to stay identical whether the account existed,
 * the email address was bad, or the SMTP server was down, otherwise the
 * response itself becomes an account-enumeration or mail-health oracle.
 * sendMail() returns { ok, error? } precisely so the caller can log a
 * failure server-side without it leaking into the HTTP response.
 */

let smtpTransporter = null

function getSmtpTransporter() {
  if (smtpTransporter) return smtpTransporter
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT || 587)
  if (!host) {
    throw new Error('MAIL_TRANSPORT=smtp but SMTP_HOST is not set')
  }
  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  })
  return smtpTransporter
}

/**
 * @param {{ to: string, subject: string, text: string, html?: string }} message
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendMail({ to, subject, text, html }) {
  const transport = (process.env.MAIL_TRANSPORT || 'console').toLowerCase()

  if (transport === 'none') {
    return { ok: true }
  }

  if (transport === 'console') {
    console.log('[mail:console] would send email', { to, subject, text })
    return { ok: true }
  }

  if (transport === 'smtp') {
    try {
      const transporter = getSmtpTransporter()
      const from = process.env.MAIL_FROM || 'no-reply@localhost'
      await transporter.sendMail({ from, to, subject, text, html })
      return { ok: true }
    } catch (err) {
      console.error('[mail:smtp] sendMail failed', { to, subject, error: err?.message })
      return { ok: false, error: err?.message || 'sendMail failed' }
    }
  }

  console.error(`[mail] Unknown MAIL_TRANSPORT "${transport}" — message not sent`, { to, subject })
  return { ok: false, error: `Unknown MAIL_TRANSPORT "${transport}"` }
}
