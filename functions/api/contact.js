// PUBLIC endpoint - the website contact form posts here.
// Stores the lead in D1 and sends Jessica an email notification.
//
// Do NOT put this path behind Cloudflare Access, or visitors cannot submit.

import { json } from '../_lib/util.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

const LIMITS = {
  name: 120,
  email: 200,
  phone: 40,
  intent: 80,
  message: 4000
};

function validPhone(raw) {
  const d = raw.replace(/\D/g, '');
  return d.length === 10 || (d.length === 11 && d[0] === '1');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await request.json();
    } else {
      data = Object.fromEntries((await request.formData()).entries());
    }
  } catch {
    return json({ success: false, message: 'Invalid request.' }, 400);
  }

  // Honeypot: bots fill hidden fields. Accept silently so they do not retry.
  if (data.botcheck) return json({ success: true });

  const name = String(data.name ?? '').trim();
  const email = String(data.email ?? '').trim();
  const phone = String(data.phone ?? '').trim();
  const intent = String(data.intent ?? '').trim();
  const message = String(data.message ?? '').trim();

  // Server-side validation. The browser checks are for UX only - anyone can
  // post here directly, so every rule has to be enforced again on this side.
  const errors = {};
  if (!name) errors.name = 'Please enter your name.';
  if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  if (!validPhone(phone)) errors.phone = 'Enter a valid 10-digit phone number.';

  for (const [field, max] of Object.entries(LIMITS)) {
    const value = String(data[field] ?? '');
    if (value.length > max) errors[field] = 'That entry is too long.';
  }

  if (Object.keys(errors).length) {
    return json({ success: false, errors, message: 'Please check the highlighted fields.' }, 400);
  }

  const now = new Date().toISOString();
  const record = { id: crypto.randomUUID(), name, email, phone, intent, message };

  // Store and notify independently: losing the lead entirely because the mail
  // relay hiccupped (or vice versa) would be worse than a partial success.
  let stored = false;
  if (env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO leads
           (id, name, email, phone, intent, message, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'new', '', ?, ?)`
      )
        .bind(record.id, name, email, phone, intent, message, now, now)
        .run();
      stored = true;
    } catch (err) {
      console.error('D1 insert failed:', err);
    }
  }

  // Fallback keeps the form working before WEB3FORMS_KEY is set in the
  // dashboard, so deploying this does not break a form that already works.
  // Safe to inline: Web3Forms access keys are public by design, and this one
  // already shipped in index.html (commit c6b20e5), so it is in git history
  // regardless. Set the env var to rotate it without touching code.
  const web3formsKey = env.WEB3FORMS_KEY || 'cf65805f-2d7c-4406-91f5-ee5b849be954';

  let notified = false;
  if (web3formsKey) {
    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: web3formsKey,
          subject: `New inquiry from ${name} — ${intent || 'general'}`,
          from_name: 'jessicakortum.com',
          name,
          email,
          phone,
          intent,
          message
        })
      });
      notified = res.ok;
    } catch (err) {
      console.error('Web3Forms notify failed:', err);
    }
  }

  if (!stored && !notified) {
    return json(
      { success: false, message: 'Could not send right now. Please email jkortumrealtor@gmail.com directly.' },
      502
    );
  }

  return json({ success: true });
}
