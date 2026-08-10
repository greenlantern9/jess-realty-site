// Cloudflare Pages "advanced mode" worker.
//
// Why this file exists instead of a functions/ directory: this project's build
// output directory is the repository root, so functions/ sat *inside* the
// static root and Pages published it as plain files rather than compiling it
// (you could read the source at /functions/api/contact.js). Pages looks for
// _worker.js at the root of the output directory, which is exactly here, so
// this is the layout that actually runs.
//
// Everything is inlined deliberately: a single-file _worker.js is not bundled,
// so it cannot import from sibling modules.
//
// Routing contract:
//   POST   /api/contact       public   - website contact form
//   GET    /api/leads         private  - admin board data
//   POST   /api/leads         private  - add a lead by hand (open house, referral)
//   PATCH  /api/leads/:id     private  - edit any field, move stage
//   DELETE /api/leads/:id     private  - remove a lead
//   everything else                    - static assets, untouched

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      // Contained on purpose: an API bug returns JSON 500 and never reaches
      // (or breaks) static asset serving for the rest of the site.
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error('API error:', err);
        return json({ error: 'Server error.' }, 500);
      }
    }

    // The output directory is the repo root, so every committed file is
    // otherwise reachable over HTTP. Hide the ones that are not site content.
    if (isPrivatePath(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }

    return env.ASSETS.fetch(request);
  }
};

/* ------------------------------------------------------------------ *
 * routing
 * ------------------------------------------------------------------ */

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/contact') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return handleContact(request, env);
  }

  if (path === '/api/leads') {
    if (request.method === 'GET')  return handleLeadList(request, env);
    if (request.method === 'POST') return handleLeadCreate(request, env);
    return methodNotAllowed('GET, POST');
  }

  if (path === '/api/export') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return handleExport(request, env);
  }

  const match = path.match(/^\/api\/leads\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (request.method === 'PATCH') return handleLeadUpdate(request, env, id);
    if (request.method === 'DELETE') return handleLeadDelete(request, env, id);
    return methodNotAllowed('PATCH, DELETE');
  }

  return json({ error: 'Not found.' }, 404);
}

// Second line of defence behind .assetsignore - keep the two in sync.
// .assetsignore stops these being uploaded at all; this catches anything that
// slips through, so a rename must be reflected in BOTH places.
const PRIVATE_FILES = new Set([
  '/worker.js',
  '/wrangler.jsonc',
  '/wrangler.toml',
  '/.assetsignore',
  '/.gitignore',
  '/schema.sql',
  '/admin-setup.md',
  '/readme.md'
]);

function isPrivatePath(pathname) {
  const p = pathname.toLowerCase();
  if (PRIVATE_FILES.has(p)) return true;
  for (const dir of ['/functions', '/test']) {
    if (p === dir || p.startsWith(dir + '/')) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function methodNotAllowed(allow) {
  return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Allow: allow,
      'Cache-Control': 'no-store'
    }
  });
}

const LEAD_STATUSES = new Set([
  'new',
  'contacted',
  'active',
  'under_contract',
  'closed',
  'lost'
]);

const LEAD_SOURCES = new Set([
  'website', 'referral', 'open_house', 'sign_call', 'zillow',
  'social', 'past_client', 'other'
]);

const LEAD_PRIORITIES = new Set(['hot', 'warm', 'cold']);

// Activity kinds for the contact log.
const ACTIVITY_TYPES = new Set(['call', 'text', 'email', 'showing', 'offer', 'note']);
const MAX_ACTIVITY_ENTRIES = 200;

const FIELD_LIMITS = {
  name: 120, email: 200, phone: 40, intent: 80,
  message: 4000, notes: 8000, tags: 300
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;   // follow-up dates are plain calendar days

function parseBudget(raw) {
  // Accepts "450000", "450,000", "$450k". Returns whole dollars, or null if unusable.
  if (raw === '' || raw === null || raw === undefined) return 0;
  const s = String(raw).trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!s) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === 'k') n *= 1e3;
  if (m[2] === 'm') n *= 1e6;
  n = Math.round(n);
  if (!Number.isFinite(n) || n < 0 || n > 100000000) return null;
  return n;
}

// The log is stored as JSON in one column rather than a side table: it is
// small, always read with its lead, and never queried on its own.
function readActivity(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * schema
 *
 * Kept in sync with schema.sql. Created on demand rather than requiring
 * someone to run it by hand: if the table is missing, a real inquiry would
 * otherwise be emailed but never stored, and the lead would be lost.
 * ------------------------------------------------------------------ */

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS leads (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     email       TEXT NOT NULL DEFAULT '',
     phone       TEXT,
     intent      TEXT,
     message     TEXT,
     status      TEXT NOT NULL DEFAULT 'new',
     notes       TEXT NOT NULL DEFAULT '',
     source      TEXT NOT NULL DEFAULT 'website',
     priority    TEXT NOT NULL DEFAULT 'warm',
     tags        TEXT NOT NULL DEFAULT '',
     next_follow_up TEXT NOT NULL DEFAULT '',
     budget      INTEGER NOT NULL DEFAULT 0,
     activity    TEXT NOT NULL DEFAULT '[]',
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC)`
];

// Columns added after the table already existed in production. Applied lazily
// the same way the table is - each is tried on its own so an already-applied
// one does not block the rest.
const MIGRATIONS = [
  `ALTER TABLE leads ADD COLUMN source   TEXT NOT NULL DEFAULT 'website'`,
  `ALTER TABLE leads ADD COLUMN priority TEXT NOT NULL DEFAULT 'warm'`,
  `ALTER TABLE leads ADD COLUMN tags     TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN next_follow_up TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN budget   INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE leads ADD COLUMN activity TEXT NOT NULL DEFAULT '[]'`
];

const errText = (err) => String((err && err.message) || err);
const isMissingTable  = (err) => /no such table/i.test(errText(err));
const isMissingColumn = (err) => /no such column|has no column/i.test(errText(err));

// Runs `query`; if the table or a newer column is missing, brings the schema
// up to date and retries once.
async function withSchema(env, query) {
  try {
    return await query();
  } catch (err) {
    const missingTable = isMissingTable(err);
    if (!missingTable && !isMissingColumn(err)) throw err;

    if (missingTable) {
      console.log('leads table missing - creating it');
      for (const sql of SCHEMA_SQL) await env.DB.prepare(sql).run();
    }

    for (const sql of MIGRATIONS) {
      try {
        await env.DB.prepare(sql).run();
      } catch (e) {
        // "duplicate column name" just means this one is already applied.
        if (!/duplicate column/i.test(errText(e))) console.error('migration failed:', e);
      }
    }
    return await query();
  }
}

// These endpoints are admin-only, so the real message is more useful to the
// person reading it than a generic string would be.
function dbErrorMessage(err) {
  return 'Database error: ' + String((err && err.message) || err);
}

/* ------------------------------------------------------------------ *
 * public: contact form
 * ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;


function validPhone(raw) {
  const d = raw.replace(/\D/g, '');
  return d.length === 10 || (d.length === 11 && d[0] === '1');
}

async function handleContact(request, env) {
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

  // The browser checks are for UX only - anyone can POST here directly, so
  // every rule is enforced again on this side.
  const errors = {};
  if (!name) errors.name = 'Please enter your name.';
  if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  if (!validPhone(phone)) errors.phone = 'Enter a valid 10-digit phone number.';

  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    if (String(data[field] ?? '').length > max) errors[field] = 'That entry is too long.';
  }

  if (Object.keys(errors).length) {
    return json({ success: false, errors, message: 'Please check the highlighted fields.' }, 400);
  }

  const now = new Date().toISOString();

  // Store and notify independently: losing the lead because the mail relay
  // hiccupped (or vice versa) would be worse than a partial success.
  let stored = false;
  if (env.DB) {
    try {
      await withSchema(env, () =>
        env.DB.prepare(
          `INSERT INTO leads
             (id, name, email, phone, intent, message, status, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'new', '', ?, ?)`
        )
          .bind(crypto.randomUUID(), name, email, phone, intent, message, now, now)
          .run()
      );
      stored = true;
    } catch (err) {
      console.error('D1 insert failed:', err);
    }
  }

  // Fallback keeps the form working before WEB3FORMS_KEY is set in the
  // dashboard. Safe to inline: Web3Forms access keys are public by design and
  // this one already shipped in index.html, so it is in git history anyway.
  const web3formsKey = env.WEB3FORMS_KEY || 'cf65805f-2d7c-4406-91f5-ee5b849be954';

  let notified = false;
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

  if (!stored && !notified) {
    return json(
      {
        success: false,
        message: 'Could not send right now. Please email jkortumrealtor@gmail.com directly.'
      },
      502
    );
  }

  return json({ success: true });
}

/* ------------------------------------------------------------------ *
 * private: lead board
 * ------------------------------------------------------------------ */

async function handleLeadList(request, env) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  try {
    const { results } = await withSchema(env, () =>
      env.DB.prepare(
        `SELECT id, name, email, phone, intent, message, status, notes,
                source, priority, tags, next_follow_up, budget, activity,
                created_at, updated_at
           FROM leads
          ORDER BY created_at DESC`
      ).all()
    );
    return json({ leads: results ?? [], user: auth.email });
  } catch (err) {
    console.error('Lead query failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

// Full export so the data is never trapped in this tool.
async function handleExport(request, env) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  const COLUMNS = [
    'name', 'email', 'phone', 'intent', 'status', 'priority', 'source',
    'budget', 'tags', 'next_follow_up', 'message', 'notes', 'created_at', 'updated_at'
  ];

  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
  // Lead text is attacker-controlled, so neutralise it before export.
  const cell = (value) => {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };

  try {
    const { results } = await withSchema(env, () =>
      env.DB.prepare(
        `SELECT ${COLUMNS.join(', ')} FROM leads ORDER BY created_at DESC`
      ).all()
    );

    const rows = [COLUMNS.join(',')];
    for (const r of results ?? []) rows.push(COLUMNS.map((c) => cell(r[c])).join(','));

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response('﻿' + rows.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="leads-${stamp}.csv"`,
        'Cache-Control': 'no-store'
      }
    });
  } catch (err) {
    console.error('Export failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

// Manually entered leads - open house sign-ins, sign calls, referrals.
async function handleLeadCreate(request, env) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const str = (k, max) => String(body[k] ?? '').trim().slice(0, max);
  const name    = str('name', FIELD_LIMITS.name);
  const email   = str('email', FIELD_LIMITS.email);
  const phone   = str('phone', FIELD_LIMITS.phone);
  const intent  = str('intent', FIELD_LIMITS.intent);
  const message = str('message', FIELD_LIMITS.message);
  const notes   = str('notes', FIELD_LIMITS.notes);
  const tags    = str('tags', FIELD_LIMITS.tags);

  // Deliberately looser than the public form: a sign call may only leave a
  // name and a number, and losing that is worse than storing a partial record.
  const errors = {};
  if (!name) errors.name = 'Name is required.';
  if (!email && !phone) errors.email = 'Add an email or a phone number.';
  if (email && !EMAIL_RE.test(email)) errors.email = 'That email does not look right.';

  const status   = body.status   || 'new';
  const source   = body.source   || 'other';
  const priority = body.priority || 'warm';
  if (!LEAD_STATUSES.has(status))     errors.status = 'Unknown stage.';
  if (!LEAD_SOURCES.has(source))      errors.source = 'Unknown source.';
  if (!LEAD_PRIORITIES.has(priority)) errors.priority = 'Unknown priority.';

  const followUp = String(body.next_follow_up ?? '').trim();
  if (followUp && !DATE_RE.test(followUp)) errors.next_follow_up = 'Use a calendar date.';

  const budget = parseBudget(body.budget);
  if (budget === null) errors.budget = 'Use a number, like 450000 or 450k.';

  if (Object.keys(errors).length) {
    return json({ error: 'Please check the highlighted fields.', errors }, 400);
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const activity = JSON.stringify([
    { at: now, type: 'note', text: 'Lead added manually (' + source.replace(/_/g, ' ') + ').' }
  ]);

  try {
    await withSchema(env, () =>
      env.DB.prepare(
        `INSERT INTO leads
           (id, name, email, phone, intent, message, status, notes,
            source, priority, tags, next_follow_up, budget, activity,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, name, email, phone, intent, message, status, notes,
              source, priority, tags, followUp, budget, activity, now, now)
        .run()
    );
    return json({ success: true, id });
  } catch (err) {
    console.error('Lead insert failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

async function handleLeadUpdate(request, env, id) {
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

  // Enumerated fields are checked against their allowed sets; free text is
  // length-capped. Anything not sent is left alone.
  const enums = { status: LEAD_STATUSES, source: LEAD_SOURCES, priority: LEAD_PRIORITIES };
  for (const [field, allowed] of Object.entries(enums)) {
    if (body[field] === undefined) continue;
    if (!allowed.has(body[field])) return json({ error: `Unknown ${field}.` }, 400);
    sets.push(`${field} = ?`);
    binds.push(body[field]);
  }

  for (const field of ['name', 'email', 'phone', 'intent', 'message', 'notes', 'tags']) {
    if (body[field] === undefined) continue;
    const value = String(body[field]).slice(0, FIELD_LIMITS[field]);
    if (field === 'name' && !value.trim()) {
      return json({ error: 'Name cannot be empty.', errors: { name: 'Name is required.' } }, 400);
    }
    if (field === 'email' && value.trim() && !EMAIL_RE.test(value.trim())) {
      return json({ error: 'That email does not look right.', errors: { email: 'Invalid email.' } }, 400);
    }
    sets.push(`${field} = ?`);
    binds.push(value);
  }

  if (body.next_follow_up !== undefined) {
    const v = String(body.next_follow_up).trim();
    if (v && !DATE_RE.test(v)) {
      return json({ error: 'Use a calendar date.', errors: { next_follow_up: 'Use a calendar date.' } }, 400);
    }
    sets.push('next_follow_up = ?');
    binds.push(v);
  }

  if (body.budget !== undefined) {
    const b = parseBudget(body.budget);
    if (b === null) {
      return json({ error: 'Budget must be a number.', errors: { budget: 'Use a number, like 450000 or 450k.' } }, 400);
    }
    sets.push('budget = ?');
    binds.push(b);
  }

  // Appending is server-side so the timestamp is trustworthy and the client
  // cannot rewrite history by posting a whole replacement array.
  if (body.activityAppend !== undefined) {
    const entry = body.activityAppend || {};
    const type = String(entry.type || 'note');
    const text = String(entry.text || '').trim().slice(0, 1000);
    if (!ACTIVITY_TYPES.has(type)) return json({ error: 'Unknown activity type.' }, 400);
    if (!text) return json({ error: 'Activity needs some text.' }, 400);

    let current = [];
    try {
      const row = await withSchema(env, () =>
        env.DB.prepare('SELECT activity FROM leads WHERE id = ?').bind(id).first()
      );
      if (!row) return json({ error: 'Lead not found.' }, 404);
      current = readActivity(row.activity);
    } catch (err) {
      console.error('Activity read failed:', err);
      return json({ error: dbErrorMessage(err) }, 500);
    }

    current.unshift({ at: new Date().toISOString(), type, text });
    sets.push('activity = ?');
    binds.push(JSON.stringify(current.slice(0, MAX_ACTIVITY_ENTRIES)));
  }

  if (!sets.length) return json({ error: 'Nothing to update.' }, 400);

  sets.push('updated_at = ?');
  binds.push(new Date().toISOString());
  binds.push(id);

  try {
    const res = await withSchema(env, () =>
      env.DB.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`)
        .bind(...binds)
        .run()
    );
    if (!res.meta?.changes) return json({ error: 'Lead not found.' }, 404);
    return json({ success: true });
  } catch (err) {
    console.error('Lead update failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

async function handleLeadDelete(request, env, id) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  try {
    const res = await withSchema(env, () =>
      env.DB.prepare('DELETE FROM leads WHERE id = ?').bind(id).run()
    );
    if (!res.meta?.changes) return json({ error: 'Lead not found.' }, 404);
    return json({ success: true });
  } catch (err) {
    console.error('Lead delete failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

/* ------------------------------------------------------------------ *
 * Cloudflare Access JWT verification
 *
 * Access already guards these routes at the edge. Verifying the signed token
 * here as well means the API fails closed rather than serving client contact
 * details if that policy is ever deleted or stops matching the path.
 * ------------------------------------------------------------------ */

const CERT_TTL_MS = 60 * 60 * 1000;
let cachedKeys = null;
let cachedAt = 0;

function b64urlToBytes(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob((str + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(str) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(str)));
}

async function getSigningKeys(teamDomain) {
  const now = Date.now();
  if (cachedKeys && now - cachedAt < CERT_TTL_MS) return cachedKeys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);

  const data = await res.json();
  cachedKeys = data.keys || [];
  cachedAt = now;
  return cachedKeys;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function requireAccess(env, request) {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const expectedAud = env.CF_ACCESS_AUD;

  // Fail closed: without config we cannot prove who the caller is.
  if (!teamDomain || !expectedAud) {
    return { ok: false, status: 503, message: 'Admin auth is not configured on the server.' };
  }

  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') || readCookie(request, 'CF_Authorization');
  if (!token) return { ok: false, status: 401, message: 'Not signed in.' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, status: 401, message: 'Malformed token.' };

  let header, payload;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch {
    return { ok: false, status: 401, message: 'Malformed token.' };
  }

  if (header.alg !== 'RS256') {
    return { ok: false, status: 401, message: 'Unsupported token algorithm.' };
  }

  let keys;
  try {
    keys = await getSigningKeys(teamDomain);
  } catch {
    return { ok: false, status: 503, message: 'Could not reach Access to verify sign-in.' };
  }

  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, status: 401, message: 'Unknown signing key.' };

  let verified = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    verified = false;
  }

  if (!verified) return { ok: false, status: 401, message: 'Invalid token signature.' };

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < nowSec) {
    return { ok: false, status: 401, message: 'Session expired — reload to sign in again.' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec) {
    return { ok: false, status: 401, message: 'Token not yet valid.' };
  }

  // Pins the token to *this* Access application.
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(expectedAud)) {
    return { ok: false, status: 401, message: 'Token audience mismatch.' };
  }

  if (payload.iss !== `https://${teamDomain}`) {
    return { ok: false, status: 401, message: 'Token issuer mismatch.' };
  }

  return { ok: true, email: payload.email || 'signed in' };
}
