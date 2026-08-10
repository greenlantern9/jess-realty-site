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
//   PATCH  /api/leads/:id     private  - move stage / edit notes
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
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return handleLeadList(request, env);
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
     email       TEXT NOT NULL,
     phone       TEXT,
     intent      TEXT,
     message     TEXT,
     status      TEXT NOT NULL DEFAULT 'new',
     notes       TEXT NOT NULL DEFAULT '',
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC)`
];

function isMissingTable(err) {
  return /no such table/i.test(String((err && err.message) || err));
}

// Runs `query`; if the table does not exist yet, creates it and retries once.
async function withSchema(env, query) {
  try {
    return await query();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    console.log('leads table missing - creating it');
    for (const sql of SCHEMA_SQL) await env.DB.prepare(sql).run();
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

const LIMITS = { name: 120, email: 200, phone: 40, intent: 80, message: 4000 };

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

  for (const [field, max] of Object.entries(LIMITS)) {
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
        `SELECT id, name, email, phone, intent, message, status, notes, created_at, updated_at
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

  if (body.status !== undefined) {
    if (!LEAD_STATUSES.has(body.status)) return json({ error: 'Unknown status.' }, 400);
    sets.push('status = ?');
    binds.push(body.status);
  }

  if (body.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(String(body.notes).slice(0, 4000));
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
