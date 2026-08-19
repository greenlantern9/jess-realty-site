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

// Plain HTTP was serving the whole site, so contact-form details (name, email,
// phone) could travel in cleartext and the page could be tampered with in
// transit. HSTS then stops the browser trying http:// again for a year.
// Content-Security-Policy.
//
// 'unsafe-inline' is required because both pages carry inline <style> and
// <script>. Removing it would mean per-request nonces via HTMLRewriter, which
// makes the HTML uncacheable - not worth it here, since neither page ever
// renders user-supplied markup (the admin builds every node with textContent).
//
// So what this actually buys: injected *external* scripts are blocked, the
// site cannot be framed, forms cannot be repointed at another origin, <base>
// cannot be hijacked, and plugins are off. Real defence in depth, but it is
// not a substitute for the escaping already in place.
// static.cloudflareinsights.com is Cloudflare's Web Analytics beacon. It is
// injected by the edge, not by our HTML, so it does not show up anywhere in
// the source - the report-only pass is what caught it. Enforcing without it
// would have silently killed the analytics.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://unpkg.com https://*.basemaps.cartocdn.com",
  "connect-src 'self' https://cloudflareinsights.com",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'"
].join('; ');

const SECURITY_HEADERS = {
  // includeSubDomains is safe here: no subdomain resolves, so nothing can be
  // locked out. preload is deliberately omitted - it is a submission to a
  // browser-baked list that takes months to reverse, and is not worth the
  // commitment for a site this size.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'Content-Security-Policy': CSP
};

function secured(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // One canonical hostname. Both www and the apex resolve to this worker, so
    // without this the same pages exist at two origins and search engines split
    // their signals between them. Upgrades the scheme in the same hop so
    // http://www never costs two redirects.
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    // Shareable section links. Link-in-bio tools (Linktree, Instagram) route
    // clicks through their own redirector, and a #fragment can get dropped on
    // the way - landing people at the top of the page instead of the section.
    // These give out a plain URL that survives that, and the fragment is
    // re-attached here at the last hop.
    const section = SECTION_LINKS[url.pathname.toLowerCase().replace(/\/+$/, '')];
    if (section) {
      return Response.redirect(new URL(section, url.origin).toString(), 302);
    }

    if (url.pathname.startsWith('/api/')) {
      // Contained on purpose: an API bug returns JSON 500 and never reaches
      // (or breaks) static asset serving for the rest of the site.
      try {
        return secured(await handleApi(request, env, url, ctx));
      } catch (err) {
        console.error('API error:', err);
        return secured(json({ error: 'Server error.' }, 500));
      }
    }

    // The output directory is the repo root, so every committed file is
    // otherwise reachable over HTTP. Hide the ones that are not site content.
    if (isPrivatePath(url.pathname)) {
      return secured(new Response('Not found', { status: 404 }));
    }

    return secured(cached(url.pathname, await env.ASSETS.fetch(request)));
  }
};

// Static assets were all being served `max-age=0, must-revalidate`, so every
// visit re-checked ~665 KB of photos. These files change rarely, so cache them
// in the browser for a week.
//
// Trade-off: filenames are not content-hashed, so replacing a photo under the
// same name can show the old one to returning visitors for up to a week. Add a
// query string (?v=2) or a new filename when swapping an image.
// /contact is safe alongside /api/contact - different paths, no collision.
const SECTION_LINKS = {
  '/contact': '/#contact',
  '/about':   '/#about',
  '/area':    '/#area',
  '/families': '/#families',
  '/schools':  '/#families',
  '/neighborhoods': '/#area',
  '/process': '/#process'
};

const LONG_CACHE = /\.(jpg|jpeg|png|webp|avif|gif|svg|ico|woff2?|ttf)$/i;

function cached(pathname, res) {
  if (!res.ok || !LONG_CACHE.test(pathname)) return res;
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
  return out;
}

/* ------------------------------------------------------------------ *
 * routing
 * ------------------------------------------------------------------ */

async function handleApi(request, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/contact') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return handleContact(request, env, ctx);
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

  if (path === '/api/campaigns') {
    if (request.method === 'GET')  return handleCampaignList(request, env);
    if (request.method === 'POST') return handleCampaignCreate(request, env);
    return methodNotAllowed('GET, POST');
  }

  // Mail-merge list built from her own contacts, never a purchased list.
  if (path === '/api/mailer') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return handleMailer(request, env);
  }

  if (path === '/api/tasks') {
    if (request.method === 'GET')  return handleTaskList(request, env);
    if (request.method === 'POST') return handleTaskCreate(request, env);
    return methodNotAllowed('GET, POST');
  }

  const task = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (task) {
    const id = decodeURIComponent(task[1]);
    if (request.method === 'PATCH')  return handleTaskUpdate(request, env, id);
    if (request.method === 'DELETE') return handleTaskDelete(request, env, id);
    return methodNotAllowed('PATCH, DELETE');
  }

  const camp = path.match(/^\/api\/campaigns\/([^/]+)$/);
  if (camp) {
    const id = decodeURIComponent(camp[1]);
    if (request.method === 'PATCH')  return handleCampaignUpdate(request, env, id);
    if (request.method === 'DELETE') return handleCampaignDelete(request, env, id);
    return methodNotAllowed('PATCH, DELETE');
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
     campaign    TEXT NOT NULL DEFAULT '',
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS campaigns (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     slug        TEXT NOT NULL,
     channel     TEXT NOT NULL DEFAULT 'other',
     objective   TEXT NOT NULL DEFAULT 'both',
     status      TEXT NOT NULL DEFAULT 'draft',
     audience    TEXT NOT NULL DEFAULT '',
     geo         TEXT NOT NULL DEFAULT '',
     creative    TEXT NOT NULL DEFAULT '',
     notes       TEXT NOT NULL DEFAULT '',
     budget      INTEGER NOT NULL DEFAULT 0,
     spend       INTEGER NOT NULL DEFAULT 0,
     starts_on   TEXT NOT NULL DEFAULT '',
     ends_on     TEXT NOT NULL DEFAULT '',
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_campaigns_slug ON campaigns(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign)`,
  `CREATE TABLE IF NOT EXISTS tasks (
     id           TEXT PRIMARY KEY,
     title        TEXT NOT NULL,
     notes        TEXT NOT NULL DEFAULT '',
     status       TEXT NOT NULL DEFAULT 'todo',
     priority     TEXT NOT NULL DEFAULT 'normal',
     assignee     TEXT NOT NULL DEFAULT '',
     due_on       TEXT NOT NULL DEFAULT '',
     lead_id      TEXT NOT NULL DEFAULT '',
     campaign_id  TEXT NOT NULL DEFAULT '',
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL,
     completed_at TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_due    ON tasks(due_on)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_lead   ON tasks(lead_id)`
];

// Columns added after the table already existed in production. Applied lazily
// the same way the table is - each is tried on its own so an already-applied
// one does not block the rest.
/* ------------------------------------------------------------------ *
 * Campaigns
 *
 * FAIR HOUSING - read before extending this.
 *
 * Housing advertising sits in a restricted category (Meta "Special Ad
 * Category", equivalent policies at Google) following the 2019 HUD/NFHA
 * settlement. Targeting by age, gender, ZIP code, or detailed demographic and
 * behavioural attributes is prohibited, and radius targeting has a 15 mile
 * floor, because those attributes proxy for protected classes - and familial
 * status is one of them.
 *
 * So this module plans, tracks and attributes campaigns. It deliberately does
 * NOT compose audience targeting, and audienceWarnings() below flags language
 * that would put a campaign on the wrong side of that line. Do not "improve"
 * this by adding demographic targeting fields.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Tasks - a work queue for Jessica or whoever helps her
 * ------------------------------------------------------------------ */

const TASK_STATUSES   = new Set(['todo', 'doing', 'waiting', 'done']);
const TASK_PRIORITIES = new Set(['high', 'normal', 'low']);
const TASK_LIMITS     = { title: 200, notes: 4000, assignee: 80 };

const CAMPAIGN_CHANNELS = new Set([
  'facebook', 'instagram', 'google', 'direct_mail', 'email',
  'open_house', 'print', 'referral_push', 'other'
]);
const CAMPAIGN_OBJECTIVES = new Set(['buyers', 'sellers', 'both', 'brand']);
const CAMPAIGN_STATUSES = new Set(['draft', 'scheduled', 'running', 'paused', 'finished']);

const CAMPAIGN_LIMITS = { name: 120, audience: 1000, geo: 300, creative: 4000, notes: 4000 };

// Terms that map onto protected classes. Presence is not proof of a violation -
// "family room" is a feature, not an audience - so these produce warnings for a
// human to judge, never a hard block.
const PROTECTED_CLASS_TERMS = [
  'age', 'young', 'older', 'senior', 'retiree', 'millennial', 'boomer',
  'male', 'female', 'men', 'women', 'gender',
  'family', 'families', 'children', 'kids', 'childless', 'single', 'married',
  'pregnant', 'newlywed', 'divorc',
  'race', 'ethnic', 'hispanic', 'latino', 'black', 'white', 'asian',
  'religio', 'christian', 'jewish', 'muslim', 'church',
  'disab', 'handicap', 'wheelchair',
  'national origin', 'immigrant', 'citizen',
  'zip code', 'zipcode'
];

function audienceWarnings(text) {
  const s = String(text || '').toLowerCase();
  const hits = PROTECTED_CLASS_TERMS.filter((t) => s.includes(t));
  return [...new Set(hits)];
}

// utm_campaign value: what ties a lead back to the campaign that produced it.
function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'campaign';
}

const MIGRATIONS = [
  `ALTER TABLE leads ADD COLUMN source   TEXT NOT NULL DEFAULT 'website'`,
  `ALTER TABLE leads ADD COLUMN priority TEXT NOT NULL DEFAULT 'warm'`,
  `ALTER TABLE leads ADD COLUMN tags     TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN next_follow_up TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN budget   INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE leads ADD COLUMN activity TEXT NOT NULL DEFAULT '[]'`,
  // utm_campaign carried in from the landing URL - this is what makes
  // cost-per-lead real rather than guessed.
  `ALTER TABLE leads ADD COLUMN campaign TEXT NOT NULL DEFAULT ''`
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

// Per-IP throttle on the public form.
//
// Fails OPEN on purpose: if the limiter is unavailable or errors, a real buyer
// still gets through. Losing genuine enquiries is a worse outcome than letting
// some spam past, and the honeypot plus validation still apply.
async function isRateLimited(env, request) {
  if (!env.CONTACT_RATE_LIMIT) return false;
  const key = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    const { success } = await env.CONTACT_RATE_LIMIT.limit({ key });
    return !success;
  } catch (err) {
    console.error('Rate limit check failed:', err);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * SMS alert on a new lead (Twilio)
 *
 * Every value here is read from encrypted secrets, never from
 * wrangler.jsonc - this repo is public, and both the auth token and the
 * recipients' personal numbers would otherwise be committed in the clear.
 *
 * Deliberately no lead details in the message: an SMS is not a private
 * channel, and it sits on a lock screen. It says a lead arrived and where
 * to read it.
 * ------------------------------------------------------------------ */

const SMS_BODY =
  'A lead has sent you a message via jessicakortum.com, navigate to jessicakortum.com/admin';

// Twilio wants E.164. Accept 10-digit US numbers and +1-prefixed alike.
function toE164(raw) {
  const s = String(raw).trim();
  if (s.startsWith('+')) return s;
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

// Free alternative to Twilio: a push notification via ntfy. Lands on the lock
// screen like a text, costs nothing, needs no card.
//
// The topic URL is the credential - anyone holding it can read and post - so
// it lives in a secret and should be long and random. Even if it leaked, the
// message deliberately carries no lead details, so the worst case is knowing
// that an enquiry arrived. Set NTFY_TOKEN too for an account-protected topic.
async function sendLeadPush(env) {
  const url = env.NTFY_TOPIC_URL;
  if (!url) return;

  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: 'New lead - jessicakortum.com',
    Priority: 'high',
    Tags: 'house',
    Click: 'https://jessicakortum.com/admin'
  };
  if (env.NTFY_TOKEN) headers.Authorization = 'Bearer ' + env.NTFY_TOKEN;

  const res = await fetch(url, { method: 'POST', headers, body: SMS_BODY });
  if (!res.ok) throw new Error(`ntfy -> ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// Whichever channels are configured fire; none configured is a no-op.
async function notifyNewLead(env) {
  const results = await Promise.allSettled([sendLeadSms(env), sendLeadPush(env)]);
  for (const r of results) if (r.status === 'rejected') console.error('Lead alert failed:', r.reason);
}

async function sendLeadSms(env) {
  const sid   = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from  = env.TWILIO_FROM_NUMBER;
  const to    = String(env.ALERT_SMS_TO || '').split(',').map(toE164).filter(Boolean);

  if (!sid || !token || !from || !to.length) return;   // not configured yet

  const results = await Promise.allSettled(to.map(async (number) => {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${sid}:${token}`),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: number, From: from, Body: SMS_BODY })
    });
    if (!res.ok) {
      // Log the last 4 digits only - full numbers do not belong in logs.
      throw new Error(`…${number.slice(-4)} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }));

  for (const r of results) if (r.status === 'rejected') console.error('SMS failed:', r.reason);
}

async function handleContact(request, env, ctx) {
  if (await isRateLimited(env, request)) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "That's a few messages in a row — give it a minute and try again."
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Retry-After': '60',
          'Cache-Control': 'no-store'
        }
      }
    );
  }

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
  // utm_campaign the visitor arrived with, forwarded by the page. Restricted to
  // slug characters so it cannot smuggle anything into the CSV export or board.
  const campaign = String(data.campaign ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, '').slice(0, 80);

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
             (id, name, email, phone, intent, message, status, notes, campaign,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'new', '', ?, ?, ?)`
        )
          .bind(crypto.randomUUID(), name, email, phone, intent, message, campaign, now, now)
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

  // Fire and forget. The visitor should not wait on Twilio, and a failed text
  // must never turn a lead we already captured into an error on their screen.
  // Honeypot hits and rate-limited requests return earlier, so bots do not
  // trigger this.
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(notifyNewLead(env));
  else notifyNewLead(env).catch((err) => console.error('Lead alert failed:', err));

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
                source, priority, tags, next_follow_up, budget, activity, campaign,
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

/* ------------------------------------------------------------------ *
 * tasks
 * ------------------------------------------------------------------ */

function readTaskBody(body) {
  const str = (k, max) => String(body[k] ?? '').trim().slice(0, max);
  const out = {
    title:       str('title', TASK_LIMITS.title),
    notes:       str('notes', TASK_LIMITS.notes),
    assignee:    str('assignee', TASK_LIMITS.assignee),
    due_on:      str('due_on', 10),
    lead_id:     str('lead_id', 64),
    campaign_id: str('campaign_id', 64),
    status:      body.status   ?? 'todo',
    priority:    body.priority ?? 'normal'
  };
  const errors = {};
  if (!out.title) errors.title = 'Give the task a title.';
  if (!TASK_STATUSES.has(out.status))     errors.status = 'Unknown status.';
  if (!TASK_PRIORITIES.has(out.priority)) errors.priority = 'Unknown priority.';
  if (out.due_on && !DATE_RE.test(out.due_on)) errors.due_on = 'Use a calendar date.';
  return { out, errors };
}

async function handleTaskList(request, env) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  try {
    // Join so a card can show "Dana Whitfield" rather than a bare id. LEFT so a
    // task survives the lead or campaign it pointed at being deleted.
    const { results } = await withSchema(env, () =>
      env.DB.prepare(
        `SELECT t.*, l.name AS lead_name, c.name AS campaign_name
           FROM tasks t
           LEFT JOIN leads     l ON l.id = t.lead_id
           LEFT JOIN campaigns c ON c.id = t.campaign_id
          ORDER BY CASE WHEN t.due_on = '' THEN 1 ELSE 0 END, t.due_on, t.created_at DESC`
      ).all()
    );
    return json({ tasks: results ?? [], user: auth.email });
  } catch (err) {
    console.error('Task query failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

async function handleTaskCreate(request, env) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }

  // A workflow template posts several at once; a single task is just a list of one.
  const items = Array.isArray(body.tasks) ? body.tasks : [body];
  if (!items.length) return json({ error: 'Nothing to create.' }, 400);
  if (items.length > 40) return json({ error: 'Too many tasks in one go.' }, 400);

  const parsed = [];
  for (const item of items) {
    const { out, errors } = readTaskBody(item);
    if (Object.keys(errors).length) {
      return json({ error: 'Please check the highlighted fields.', errors }, 400);
    }
    parsed.push(out);
  }

  const now = new Date().toISOString();
  try {
    for (const t of parsed) {
      await withSchema(env, () =>
        env.DB.prepare(
          `INSERT INTO tasks
             (id, title, notes, status, priority, assignee, due_on,
              lead_id, campaign_id, created_at, updated_at, completed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          crypto.randomUUID(), t.title, t.notes, t.status, t.priority, t.assignee,
          t.due_on, t.lead_id, t.campaign_id, now, now,
          t.status === 'done' ? now : ''
        ).run()
      );
    }
    return json({ success: true, created: parsed.length });
  } catch (err) {
    console.error('Task insert failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

async function handleTaskUpdate(request, env, id) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }

  const { out, errors } = readTaskBody({ title: 'placeholder', ...body });
  if (body.title !== undefined && !String(body.title).trim()) {
    return json({ error: 'Give the task a title.', errors: { title: 'Required.' } }, 400);
  }
  delete errors.title;
  if (Object.keys(errors).length) {
    return json({ error: 'Please check the highlighted fields.', errors }, 400);
  }

  const sets = [], binds = [];
  for (const f of ['title','notes','status','priority','assignee','due_on','lead_id','campaign_id']) {
    if (body[f] === undefined) continue;
    sets.push(`${f} = ?`); binds.push(out[f]);
  }
  if (!sets.length) return json({ error: 'Nothing to update.' }, 400);

  const now = new Date().toISOString();
  // Stamp when it was finished, and clear it if the task is reopened.
  if (body.status !== undefined) {
    sets.push('completed_at = ?');
    binds.push(out.status === 'done' ? now : '');
  }
  sets.push('updated_at = ?'); binds.push(now);
  binds.push(id);

  try {
    const res = await withSchema(env, () =>
      env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
    );
    if (!res.meta?.changes) return json({ error: 'Task not found.' }, 404);
    return json({ success: true });
  } catch (err) {
    console.error('Task update failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

async function handleTaskDelete(request, env, id) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  try {
    const res = await withSchema(env, () =>
      env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run()
    );
    if (!res.meta?.changes) return json({ error: 'Task not found.' }, 404);
    return json({ success: true });
  } catch (err) {
    console.error('Task delete failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

/* ------------------------------------------------------------------ *
 * campaigns: plan, track spend, attribute leads
 * ------------------------------------------------------------------ */

function readCampaignBody(body) {
  const str = (k, max) => String(body[k] ?? '').trim().slice(0, max);
  const out = {
    name:     str('name', CAMPAIGN_LIMITS.name),
    audience: str('audience', CAMPAIGN_LIMITS.audience),
    geo:      str('geo', CAMPAIGN_LIMITS.geo),
    creative: str('creative', CAMPAIGN_LIMITS.creative),
    notes:    str('notes', CAMPAIGN_LIMITS.notes),
    channel:   body.channel   ?? 'other',
    objective: body.objective ?? 'both',
    status:    body.status    ?? 'draft',
    starts_on: str('starts_on', 10),
    ends_on:   str('ends_on', 10)
  };
  const errors = {};
  if (!out.name) errors.name = 'Give the campaign a name.';
  if (!CAMPAIGN_CHANNELS.has(out.channel))     errors.channel = 'Unknown channel.';
  if (!CAMPAIGN_OBJECTIVES.has(out.objective)) errors.objective = 'Unknown objective.';
  if (!CAMPAIGN_STATUSES.has(out.status))      errors.status = 'Unknown status.';
  for (const k of ['starts_on', 'ends_on']) {
    if (out[k] && !DATE_RE.test(out[k])) errors[k] = 'Use a calendar date.';
  }
  for (const k of ['budget', 'spend']) {
    if (body[k] === undefined) continue;
    const v = parseBudget(body[k]);
    if (v === null) { errors[k] = 'Use a number, like 250 or 1.5k.'; continue; }
    out[k] = v;
  }
  return { out, errors };
}

async function handleCampaignList(request, env) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  try {
    // Attribution: leads carry the utm_campaign they arrived with, so
    // cost-per-lead is measured rather than estimated.
    const { results } = await withSchema(env, () =>
      env.DB.prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM leads l WHERE l.campaign = c.slug) AS leads,
                (SELECT COUNT(*) FROM leads l WHERE l.campaign = c.slug
                   AND l.status IN ('active','under_contract','closed')) AS qualified,
                (SELECT COUNT(*) FROM leads l WHERE l.campaign = c.slug
                   AND l.status = 'closed') AS closed
           FROM campaigns c
          ORDER BY c.created_at DESC`
      ).all()
    );
    const campaigns = (results ?? []).map((c) => ({
      ...c,
      warnings: audienceWarnings(c.audience + ' ' + c.creative)
    }));
    return json({ campaigns, user: auth.email });
  } catch (err) {
    console.error('Campaign query failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

async function handleCampaignCreate(request, env) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }

  const { out, errors } = readCampaignBody(body);
  if (Object.keys(errors).length) {
    return json({ error: 'Please check the highlighted fields.', errors }, 400);
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const slug = slugify(out.name) + '-' + id.slice(0, 4);

  try {
    await withSchema(env, () =>
      env.DB.prepare(
        `INSERT INTO campaigns
           (id, name, slug, channel, objective, status, audience, geo, creative,
            notes, budget, spend, starts_on, ends_on, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id, out.name, slug, out.channel, out.objective, out.status,
        out.audience, out.geo, out.creative, out.notes,
        out.budget ?? 0, out.spend ?? 0, out.starts_on, out.ends_on, now, now
      ).run()
    );
    return json({ success: true, id, slug, warnings: audienceWarnings(out.audience + ' ' + out.creative) });
  } catch (err) {
    console.error('Campaign insert failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

async function handleCampaignUpdate(request, env, id) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }

  const { out, errors } = readCampaignBody({ name: 'placeholder', ...body });
  // name is only required when it is actually being changed
  if (body.name !== undefined && !String(body.name).trim()) {
    return json({ error: 'Give the campaign a name.', errors: { name: 'Required.' } }, 400);
  }
  delete errors.name;
  if (Object.keys(errors).length) {
    return json({ error: 'Please check the highlighted fields.', errors }, 400);
  }

  const sets = [], binds = [];
  for (const f of ['name','channel','objective','status','audience','geo','creative','notes','starts_on','ends_on']) {
    if (body[f] === undefined) continue;
    sets.push(`${f} = ?`); binds.push(out[f]);
  }
  for (const f of ['budget','spend']) {
    if (body[f] === undefined) continue;
    sets.push(`${f} = ?`); binds.push(out[f] ?? 0);
  }
  if (!sets.length) return json({ error: 'Nothing to update.' }, 400);

  sets.push('updated_at = ?'); binds.push(new Date().toISOString());
  binds.push(id);

  try {
    const res = await withSchema(env, () =>
      env.DB.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
    );
    if (!res.meta?.changes) return json({ error: 'Campaign not found.' }, 404);
    return json({ success: true });
  } catch (err) {
    console.error('Campaign update failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

async function handleCampaignDelete(request, env, id) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  try {
    const res = await withSchema(env, () =>
      env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(id).run()
    );
    if (!res.meta?.changes) return json({ error: 'Campaign not found.' }, 404);
    return json({ success: true });
  } catch (err) {
    console.error('Campaign delete failed:', err);
    return json({ error: dbErrorMessage(err) }, 500);
  }
}

// Mail-merge CSV for a print house, built from contacts already in the CRM.
// ?status=, ?tag=, ?campaign= narrow it. Never a bought list.
async function handleMailer(request, env) {
  const auth = await requireAccess(env, request);
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (!env.DB) return json({ error: 'Lead database is not bound.' }, 503);

  const p = new URL(request.url).searchParams;
  const where = [], binds = [];
  if (p.get('status'))   { where.push('status = ?');   binds.push(p.get('status')); }
  if (p.get('campaign')) { where.push('campaign = ?'); binds.push(p.get('campaign')); }
  if (p.get('tag'))      { where.push('tags LIKE ?');  binds.push('%' + p.get('tag') + '%'); }

  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const COLUMNS = ['name','email','phone','intent','status','tags','campaign','created_at'];

  try {
    const { results } = await withSchema(env, () =>
      env.DB.prepare(
        `SELECT ${COLUMNS.join(', ')} FROM leads
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY created_at DESC`
      ).bind(...binds).all()
    );
    const rows = [COLUMNS.join(',')];
    for (const r of results ?? []) rows.push(COLUMNS.map((c) => cell(r[c])).join(','));
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response('﻿' + rows.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="mailer-${stamp}.csv"`,
        'Cache-Control': 'no-store'
      }
    });
  } catch (err) {
    console.error('Mailer export failed:', err);
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
  const campaign = str('campaign', 80);   // set by hand when logging an open-house walk-in

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
            source, priority, tags, next_follow_up, budget, activity, campaign,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, name, email, phone, intent, message, status, notes,
              source, priority, tags, followUp, budget, activity, campaign, now, now)
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
