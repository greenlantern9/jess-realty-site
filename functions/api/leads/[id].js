// PROTECTED - update or remove a single lead.

import { json, LEAD_STATUSES } from '../../_lib/util.js';
import { requireAccess } from '../../_lib/auth.js';

const VALID_STATUS = new Set(LEAD_STATUSES);
const MAX_NOTES = 4000;

export async function onRequestPatch(context) {
  const { request, env, params } = context;

  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const sets = [];
  const binds = [];

  if (body.status !== undefined) {
    if (!VALID_STATUS.has(body.status)) {
      return json({ error: 'Unknown status.' }, 400);
    }
    sets.push('status = ?');
    binds.push(body.status);
  }

  if (body.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(String(body.notes).slice(0, MAX_NOTES));
  }

  if (!sets.length) return json({ error: 'Nothing to update.' }, 400);

  sets.push('updated_at = ?');
  binds.push(new Date().toISOString());
  binds.push(params.id);

  try {
    const res = await env.DB.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();

    if (!res.meta?.changes) return json({ error: 'Lead not found.' }, 404);
    return json({ success: true });
  } catch (err) {
    console.error('Lead update failed:', err);
    return json({ error: 'Could not update lead.' }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;

  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  try {
    const res = await env.DB.prepare('DELETE FROM leads WHERE id = ?').bind(params.id).run();
    if (!res.meta?.changes) return json({ error: 'Lead not found.' }, 404);
    return json({ success: true });
  } catch (err) {
    console.error('Lead delete failed:', err);
    return json({ error: 'Could not delete lead.' }, 500);
  }
}
