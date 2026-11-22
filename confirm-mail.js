'use strict';
// Sign-up confirmation without saving anything first.
// The sign-up details travel inside the emailed link as an encrypted, expiring token (AES-256-GCM, key from AUTH_SECRET).
// Nothing is stored in Supabase or on this server until the person clicks the link, so a restart loses nothing.

const crypto = require('crypto');
const nodemailer = require('nodemailer');

function key() {
  return crypto.createHash('sha256').update(String(process.env.AUTH_SECRET || '')).digest();
}

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(str) { return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function makeToken(email, password, username, ttlMs) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = JSON.stringify({ e: email, p: password, u: username, x: Date.now() + ttlMs });
  const enc = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), enc]));
}

// -> { email, password, username } or { error: 'invalid' | 'expired' }
function readToken(token) {
  try {
    const raw = unb64url(token);
    if (raw.length < 29) return { error: 'invalid' };
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    if (typeof data.x !== 'number' || Date.now() > data.x) return { error: 'expired' };
    return { email: data.e, password: data.p, username: data.u };
  } catch (e) {
    return { error: 'invalid' }; // forged, damaged or made with another secret
  }
}

function configured() {
  return Boolean(process.env.AUTH_SECRET && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transport = null;
function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 465;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

function html(username, email, link, minutes) {
  const u = esc(username), e = esc(email), l = esc(link);
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>Confirm your Type Sprint account</title></head>'
    + '<body style="margin:0;padding:0;background:#2043f0;">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">One tap to confirm your email and start racing.</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#2043f0;"><tr><td align="center" style="padding:32px 16px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">'
    + '<tr><td style="padding:0 0 16px 0;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:800;letter-spacing:1px;color:#ffffff;">TYPE SPRINT</td></tr>'
    + '<tr><td style="background:#ffffff;border:3px solid #0a0f2a;border-radius:14px;padding:32px 28px;font-family:Arial,Helvetica,sans-serif;color:#0a0f2a;">'
    + '<h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.25;color:#0a0f2a;">Welcome, ' + u + '!</h1>'
    + '<p style="margin:0 0 24px 0;font-size:16px;line-height:1.55;color:#0a0f2a;">You&rsquo;re almost on the starting line. Confirm that <strong>' + e + '</strong> is yours to create your account, then log in and race.</p>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px auto;"><tr><td align="center" style="background:#ffd23f;border:3px solid #0a0f2a;border-radius:10px;">'
    + '<a href="' + l + '" style="display:inline-block;padding:14px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:800;color:#0a0f2a;text-decoration:none;">Confirm my email</a></td></tr></table>'
    + '<p style="margin:0 0 8px 0;font-size:13px;line-height:1.5;color:#5a6385;">Button not working? Copy and paste this link into your browser:</p>'
    + '<p style="margin:0 0 24px 0;font-size:13px;line-height:1.5;word-break:break-all;"><a href="' + l + '" style="color:#2043f0;">' + l + '</a></p>'
    + '<hr style="border:0;border-top:1px solid #e3e6f2;margin:0 0 16px 0;">'
    + '<p style="margin:0;font-size:12px;line-height:1.5;color:#5a6385;">This link works for ' + minutes + ' minutes. Didn&rsquo;t sign up for Type Sprint? Ignore this email &mdash; no account was created.</p>'
    + '</td></tr>'
    + '<tr><td style="padding:16px 0 0 0;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#dfe5ff;">Sent by Type Sprint &middot; This is an automated message, please don&rsquo;t reply.</td></tr>'
    + '</table></td></tr></table></body></html>';
}

async function sendConfirmation(email, username, link, ttlMs) {
  const minutes = Math.round(ttlMs / 60000);
  const from = process.env.MAIL_FROM || ('Type Sprint <' + process.env.SMTP_USER + '>');
  await getTransport().sendMail({
    from: from,
    to: email,
    subject: 'Confirm your Type Sprint account',
    text: 'Welcome to Type Sprint, ' + username + '!\n\nConfirm your email to create your account (link works for ' + minutes + ' minutes):\n' + link + '\n\nDidn\'t sign up? Ignore this email; no account was created.',
    html: html(username, email, link, minutes),
  });
}

module.exports = { makeToken: makeToken, readToken: readToken, configured: configured, sendConfirmation: sendConfirmation };
