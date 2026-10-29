import nodemailer from 'nodemailer'

/**
 * Pluggable mail transport, selected entirely through environment
 * settings (MAIL_TRANSPORT) rather than a code change — see .env.example
 * for every variable this reads.
 *
 *   MAIL_TRANSPORT=smtp     → real delivery via nodemailer's SMTP
 *                              transport (SMTP_HOST/PORT/SECURE/USER/PASS,
 *                              MAIL_FROM).
 *   MAIL_TRANSPORT=brevo    → delivery via Brevo's HTTPS API (BREVO_API_KEY,
 *                              MAIL_FROM = a sender verified in Brevo).
 *   MAIL_TRANSPORT=resend   → delivery via Resend's HTTPS API (RESEND_API_KEY,
 *                              MAIL_FROM on a domain verified in Resend).
 *                              brevo/resend use port 443, so they work on
 *                              hosts that block outbound SMTP (e.g. Railway
 *                              Free/Hobby plans).
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
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  })
  return smtpTransporter
}

const HTTP_TIMEOUT_MS = 10000

// "Name <a@b.com>" or "a@b.com" → { name?, email }
function parseFrom(from) {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(from)
  if (m) return { name: m[1]?.trim() || undefined, email: m[2].trim() }
  return { email: from.trim() }
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 500)
    throw new Error(`HTTP ${res.status} ${detail}`)
  }
}

async function sendViaBrevo({ from, to, subject, text, html }) {
  const apiKey = process.env.BREVO_API_KEY
  if (!apiKey) throw new Error('MAIL_TRANSPORT=brevo but BREVO_API_KEY is not set')
  const sender = parseFrom(from)
  await postJson('https://api.brevo.com/v3/smtp/email', { 'api-key': apiKey }, {
    sender,
    to: [{ email: to }],
    subject,
    textContent: text,
    ...(html ? { htmlContent: html } : {}),
  })
}

async function sendViaResend({ from, to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('MAIL_TRANSPORT=resend but RESEND_API_KEY is not set')
  await postJson('https://api.resend.com/emails', { Authorization: `Bearer ${apiKey}` }, {
    from,
    to: [to],
    subject,
    text,
    ...(html ? { html } : {}),
  })
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

  if (transport === 'brevo' || transport === 'resend') {
    try {
      const from = process.env.MAIL_FROM
      if (!from) throw new Error(`MAIL_TRANSPORT=${transport} but MAIL_FROM is not set`)
      const send = transport === 'brevo' ? sendViaBrevo : sendViaResend
      await send({ from, to, subject, text, html })
      return { ok: true }
    } catch (err) {
      const msg = err?.name === 'TimeoutError' ? 'request timed out' : err?.message
      console.error(`[mail:${transport}] sendMail failed`, { to, subject, error: msg })
      return { ok: false, error: msg || 'sendMail failed' }
    }
  }

  console.error(`[mail] Unknown MAIL_TRANSPORT "${transport}" — message not sent`, { to, subject })
  return { ok: false, error: `Unknown MAIL_TRANSPORT "${transport}"` }
}
