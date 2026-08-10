// PROTECTED - lead list for the admin board.
// Guarded twice: Cloudflare Access in front of /api/leads*, plus JWT
// verification here so this fails closed if that policy ever goes away.

import { json } from '../../_lib/util.js';
import { requireAccess } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);

  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, email, phone, intent, message, status, notes, created_at, updated_at
         FROM leads
        ORDER BY created_at DESC`
    ).all();

    return json({ leads: results ?? [], user: auth.email });
  } catch (err) {
    console.error('Lead query failed:', err);
    return json({ error: 'Could not load leads.' }, 500);
  }
}
