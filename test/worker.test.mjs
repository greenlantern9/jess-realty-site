import worker from '../worker.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
};

const TEAM = 'test-team.cloudflareaccess.com';
const AUD  = 'test-audience-tag';

const staticEnv = () => ({ ASSETS: { fetch: async () => new Response('STATIC-ASSET') } });

const req = (path, method = 'GET', body = null, headers = {}) =>
  new Request('https://x.com' + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : null
  });

/* ------------------------------------------------------------------ *
 * A real signed Access token, so the authenticated routes can be
 * exercised instead of always stopping at the 401.
 * ------------------------------------------------------------------ */

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const KID = 'test-key-1';
const keyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify']
);
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
const JWKS = { keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] };

async function mintToken(overrides = {}) {
  const header  = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const payload = {
    aud: [AUD],
    iss: 'https://' + TEAM,
    email: 'jkortumrealtor@gmail.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides
  };
  const signingInput =
    b64url(new TextEncoder().encode(JSON.stringify(header))) + '.' +
    b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(signingInput)
  );
  return signingInput + '.' + b64url(new Uint8Array(sig));
}

// Serve the JWKS the worker fetches to verify tokens; everything else is stubbed.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('/cdn-cgi/access/certs')) {
    return new Response(JSON.stringify(JWKS), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{"success":true}', { status: 200 });
};

const TOKEN = await mintToken();
const authEnv = (db) => ({
  ...staticEnv(), DB: db, CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD
});
const authReq = (path, method, body) =>
  req(path, method, body, { 'Cf-Access-Jwt-Assertion': TOKEN });

/* ------------------------------------------------------------------ */
console.log('\n1. missing table is created on demand and the insert retried');

let insertAttempts = 0;
const executed = [];
function stmt(sql) {
  return {
    bind: () => stmt(sql),
    run: async () => {
      executed.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/^\s*INSERT/i.test(sql)) {
        insertAttempts++;
        if (insertAttempts === 1) throw new Error('D1_ERROR: no such table: leads');
      }
      return { meta: { changes: 1 } };
    },
    all: async () => ({ results: [] })
  };
}

let res = await worker.fetch(
  req('/api/contact', 'POST', {
    name: 'Test', email: 'a@b.com', phone: '8135550142', intent: 'Buy a home', message: 'hi'
  }),
  { ...staticEnv(), DB: { prepare: stmt } }
);
check('contact returns 200', res.status === 200, 'got ' + res.status);
check('insert attempted twice (fail, create, retry)', insertAttempts === 2, 'got ' + insertAttempts);
check('CREATE TABLE was issued', executed.some((s) => s.startsWith('CREATE TABLE')));
check('indexes were created', executed.filter((s) => s.startsWith('CREATE INDEX')).length === 2);

/* ------------------------------------------------------------------ */
console.log('\n2. a real DB error is NOT mistaken for a missing table');

let attempts = 0;
const brokenDb = {
  prepare: () => ({
    bind() { return this; },
    run: async () => { attempts++; throw new Error('D1_ERROR: database is locked'); },
    all: async () => { attempts++; throw new Error('D1_ERROR: database is locked'); }
  })
};
res = await worker.fetch(
  req('/api/contact', 'POST', {
    name: 'Test', email: 'a@b.com', phone: '8135550142', intent: 'Buy', message: 'hi'
  }),
  { ...staticEnv(), DB: brokenDb }
);
check('no retry loop on unrelated errors', attempts === 1, 'attempts=' + attempts);
check('still succeeds via email fallback', res.status === 200, 'got ' + res.status);

/* ------------------------------------------------------------------ */
console.log('\n3. admin routes fail closed');

for (const [label, method] of [['GET', 'GET'], ['POST', 'POST']]) {
  res = await worker.fetch(
    req('/api/leads', method, method === 'POST' ? { name: 'X' } : null),
    { ...staticEnv(), DB: { prepare: stmt } }
  );
  check(label + ' /api/leads -> 503 when unconfigured', res.status === 503, 'got ' + res.status);

  res = await worker.fetch(
    req('/api/leads', method, method === 'POST' ? { name: 'X' } : null),
    authEnv({ prepare: stmt })
  );
  check(label + ' /api/leads -> 401 without a token', res.status === 401, 'got ' + res.status);
}

// A token signed correctly but minted for a different Access app must not work.
const wrongAud = await mintToken({ aud: ['some-other-app'] });
res = await worker.fetch(
  req('/api/leads', 'GET', null, { 'Cf-Access-Jwt-Assertion': wrongAud }),
  authEnv({ prepare: stmt })
);
check('token for another audience is rejected', res.status === 401, 'got ' + res.status);

const expired = await mintToken({ exp: Math.floor(Date.now() / 1000) - 60 });
res = await worker.fetch(
  req('/api/leads', 'GET', null, { 'Cf-Access-Jwt-Assertion': expired }),
  authEnv({ prepare: stmt })
);
check('expired token is rejected', res.status === 401, 'got ' + res.status);

/* ------------------------------------------------------------------ */
console.log('\n4. a valid token reaches the data');

res = await worker.fetch(authReq('/api/leads'), authEnv({ prepare: stmt }));
const listBody = await res.json();
check('GET /api/leads -> 200 with a valid token', res.status === 200, 'got ' + res.status);
check('returns the verified signer', listBody.user === 'jkortumrealtor@gmail.com', JSON.stringify(listBody));

/* ------------------------------------------------------------------ */
console.log('\n5. a table missing the newer columns is migrated, then retried');

const sawAlter = [];
let selectAttempts = 0;
function legacyStmt(sql) {
  return {
    bind() { return this; },
    run: async () => {
      const m = sql.match(/ADD COLUMN\s+(\w+)/i);
      if (m) sawAlter.push(m[1]);
      return { meta: { changes: 1 } };
    },
    all: async () => {
      if (/^\s*SELECT/i.test(sql)) {
        selectAttempts++;
        if (selectAttempts === 1) throw new Error('D1_ERROR: no such column: priority');
      }
      return { results: [] };
    }
  };
}
res = await worker.fetch(authReq('/api/leads'), authEnv({ prepare: legacyStmt }));
check('ALTER issued for source/priority/tags',
  ['source', 'priority', 'tags'].every((c) => sawAlter.includes(c)), 'saw ' + JSON.stringify(sawAlter));
check('select retried after migrating', selectAttempts === 2, 'attempts=' + selectAttempts);
check('request succeeds after migrating', res.status === 200, 'got ' + res.status);

/* ------------------------------------------------------------------ */
console.log('\n6. manually added leads are validated');

const okDb = { prepare: () => ({ bind() { return this; },
  run: async () => ({ meta: { changes: 1 } }), all: async () => ({ results: [] }) }) };

const cases = [
  ['no name',            { phone: '8135550142' },                       400],
  ['no way to reach',    { name: 'Walk-in' },                           400],
  ['bad email',          { name: 'X', email: 'nope' },                  400],
  ['unknown stage',      { name: 'X', phone: '813', status: 'bogus' },  400],
  ['unknown source',     { name: 'X', phone: '813', source: 'bogus' },  400],
  ['phone only is fine', { name: 'Sign call', phone: '(813) 555-0142' }, 200],
  ['email only is fine', { name: 'Referral', email: 'a@b.com' },        200]
];
for (const [label, body, expected] of cases) {
  const r = await worker.fetch(authReq('/api/leads', 'POST', body), authEnv(okDb));
  check('create: ' + label.padEnd(20) + ' -> ' + expected, r.status === expected, 'got ' + r.status);
}

// Editing must reject the same bad values the create path does.
const bad = await worker.fetch(
  authReq('/api/leads/abc', 'PATCH', { priority: 'nuclear' }), authEnv(okDb));
check('patch rejects unknown priority', bad.status === 400, 'got ' + bad.status);

const blankName = await worker.fetch(
  authReq('/api/leads/abc', 'PATCH', { name: '   ' }), authEnv(okDb));
check('patch rejects a blank name', blankName.status === 400, 'got ' + blankName.status);

const okPatch = await worker.fetch(
  authReq('/api/leads/abc', 'PATCH', { priority: 'hot', tags: 'waterfront' }), authEnv(okDb));
check('patch accepts valid fields', okPatch.status === 200, 'got ' + okPatch.status);

/* ------------------------------------------------------------------ */
console.log('\n7. follow-up dates, budgets and the activity log');

const budgetCases = [
  ['450000',  200], ['450k', 200], ['$450,000', 200], ['1.2m', 200],
  ['', 200], ['abc', 400], ['-5', 400], ['999999999999', 400]
];
for (const [value, expected] of budgetCases) {
  const r = await worker.fetch(
    authReq('/api/leads', 'POST', { name: 'B', phone: '813', budget: value }), authEnv(okDb));
  check('budget ' + JSON.stringify(value).padEnd(16) + ' -> ' + expected,
    r.status === expected, 'got ' + r.status);
}

for (const [value, expected] of [['2026-09-01', 200], ['next tuesday', 400], ['', 200]]) {
  const r = await worker.fetch(
    authReq('/api/leads', 'POST', { name: 'F', phone: '813', next_follow_up: value }), authEnv(okDb));
  check('follow-up ' + JSON.stringify(value).padEnd(16) + ' -> ' + expected,
    r.status === expected, 'got ' + r.status);
}

// Appending reads the current log, prepends, and writes back with a
// server-side timestamp the client cannot forge.
let storedActivity = null;
const activityDb = { prepare: (sql) => ({
  _sql: sql,
  bind(...a){ this._binds = a; return this; },
  first: async () => ({ activity: JSON.stringify([{ at:'2026-01-01T00:00:00Z', type:'call', text:'older' }]) }),
  run: async function(){
    if (/UPDATE/i.test(this._sql)) storedActivity = this._binds.find(b => typeof b === 'string' && b.startsWith('['));
    return { meta: { changes: 1 } };
  },
  all: async () => ({ results: [] })
}) };

let r2 = await worker.fetch(
  authReq('/api/leads/abc', 'PATCH', { activityAppend: { type:'showing', text:'Toured 3 homes' } }),
  authEnv(activityDb));
check('activity append -> 200', r2.status === 200, 'got ' + r2.status);
const parsedLog = JSON.parse(storedActivity || '[]');
check('newest entry is first', parsedLog[0] && parsedLog[0].text === 'Toured 3 homes', storedActivity);
check('existing entries preserved', parsedLog.length === 2 && parsedLog[1].text === 'older');
check('timestamp is server-set', !!parsedLog[0] && !Number.isNaN(Date.parse(parsedLog[0].at)));

r2 = await worker.fetch(
  authReq('/api/leads/abc', 'PATCH', { activityAppend: { type:'telepathy', text:'x' } }), authEnv(activityDb));
check('unknown activity type rejected', r2.status === 400, 'got ' + r2.status);

r2 = await worker.fetch(
  authReq('/api/leads/abc', 'PATCH', { activityAppend: { type:'call', text:'   ' } }), authEnv(activityDb));
check('empty activity text rejected', r2.status === 400, 'got ' + r2.status);

/* ------------------------------------------------------------------ */
console.log('\n8. CSV export');

res = await worker.fetch(req('/api/export'), { ...staticEnv(), DB: okDb });
check('export -> 503 when unconfigured', res.status === 503, 'got ' + res.status);
res = await worker.fetch(req('/api/export'), authEnv(okDb));
check('export -> 401 without a token', res.status === 401, 'got ' + res.status);

const exportDb = { prepare: () => ({ bind() { return this; },
  run: async () => ({ meta:{ changes:1 } }),
  all: async () => ({ results: [
    { name:'Dana "D" Whitfield', email:'d@x.com', phone:'813', intent:'Buy',
      status:'new', priority:'hot', source:'website', budget:450000, tags:'a, b',
      next_follow_up:'2026-09-01', message:'line1\nline2', notes:'',
      created_at:'2026-08-01T00:00:00Z', updated_at:'2026-08-01T00:00:00Z' },
    { name:'=cmd|calc', email:'', phone:'', intent:'', status:'new', priority:'warm',
      source:'other', budget:0, tags:'', next_follow_up:'', message:'', notes:'',
      created_at:'2026-08-02T00:00:00Z', updated_at:'2026-08-02T00:00:00Z' }
  ] }) }) };

res = await worker.fetch(authReq('/api/export'), authEnv(exportDb));
const csv = await res.text();
check('export -> 200 with a valid token', res.status === 200, 'got ' + res.status);
check('sends a csv attachment',
  (res.headers.get('content-type') || '').includes('text/csv') &&
  (res.headers.get('content-disposition') || '').includes('attachment'));
check('quotes inside values are doubled', csv.includes('"Dana ""D"" Whitfield"'), csv.slice(0, 120));
check('newlines survive inside a quoted cell', csv.includes('line1\nline2'));
// A cell starting with = would execute as a formula when opened in Excel.
check('formula injection neutralised', csv.includes(`"'=cmd|calc"`), csv.slice(-200));

/* ------------------------------------------------------------------ */
console.log('\n9. routing and private files');

for (const [path, status] of [
  ['/', 200], ['/schema.sql', 404], ['/worker.js', 404], ['/wrangler.jsonc', 404],
  ['/functions/api/contact.js', 404], ['/test/worker.test.mjs', 404], ['/api/nope', 404]
]) {
  const r = await worker.fetch(req(path), staticEnv());
  check(path.padEnd(28) + ' -> ' + status, r.status === status, 'got ' + r.status);
}

/* ------------------------------------------------------------------ */
console.log('\n7b. contact form rate limiting');

const contactBody = {
  name: 'Test', email: 'a@b.com', phone: '8135550142', intent: 'Buy', message: 'hi'
};
const okDbRl = { prepare: () => ({ bind() { return this; },
  run: async () => ({ meta: { changes: 1 } }), all: async () => ({ results: [] }) }) };

let limited = await worker.fetch(
  req('/api/contact', 'POST', contactBody),
  { ...staticEnv(), DB: okDbRl, CONTACT_RATE_LIMIT: { limit: async () => ({ success: false }) } }
);
check('over the limit -> 429', limited.status === 429, 'got ' + limited.status);
check('sends Retry-After', limited.headers.get('retry-after') === '60',
  limited.headers.get('retry-after'));

let allowed = await worker.fetch(
  req('/api/contact', 'POST', contactBody),
  { ...staticEnv(), DB: okDbRl, CONTACT_RATE_LIMIT: { limit: async () => ({ success: true }) } }
);
check('under the limit -> 200', allowed.status === 200, 'got ' + allowed.status);

// A broken limiter must not take the contact form offline.
let brokenLimiter = await worker.fetch(
  req('/api/contact', 'POST', contactBody),
  { ...staticEnv(), DB: okDbRl,
    CONTACT_RATE_LIMIT: { limit: async () => { throw new Error('limiter down'); } } }
);
check('limiter error fails open', brokenLimiter.status === 200, 'got ' + brokenLimiter.status);

let noLimiter = await worker.fetch(
  req('/api/contact', 'POST', contactBody), { ...staticEnv(), DB: okDbRl }
);
check('missing binding fails open', noLimiter.status === 200, 'got ' + noLimiter.status);

/* ------------------------------------------------------------------ */
console.log('\n7c. SMS alert on a new lead');

const smsDb = { prepare: () => ({ bind() { return this; },
  run: async () => ({ meta: { changes: 1 } }), all: async () => ({ results: [] }) }) };
const goodLead = { name:'Dana', email:'d@e.com', phone:'8135550142', intent:'Buy', message:'hi' };
const smsEnv = (extra = {}) => ({
  ...staticEnv(), DB: smsDb,
  TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_FROM_NUMBER: '+15005550006',
  ALERT_SMS_TO: '8134944125, 9419629677',
  ...extra
});
// ctx.waitUntil is how the Workers runtime keeps background work alive.
const capturingCtx = () => { const p = []; return { waitUntil: (x) => p.push(x), settle: () => Promise.allSettled(p) }; };

let smsCalls = [];
const savedFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('api.twilio.com')) {
    smsCalls.push({ url, body: init.body.toString(), auth: init.headers.Authorization });
    return new Response('{"sid":"SM1"}', { status: 201 });
  }
  if (url.includes('/cdn-cgi/access/certs')) return new Response(JSON.stringify(JWKS));
  return new Response('{"success":true}', { status: 200 });
};

let ctx = capturingCtx();
let smsRes = await worker.fetch(req('/api/contact', 'POST', goodLead), smsEnv(), ctx);
await ctx.settle();
check('submission succeeds', smsRes.status === 200, 'got ' + smsRes.status);
check('texts both numbers', smsCalls.length === 2, 'sent ' + smsCalls.length);
check('numbers normalised to E.164',
  smsCalls.every(c => /To=%2B1(8134944125|9419629677)/.test(c.body)),
  smsCalls.map(c=>c.body).join(' | '));
// Parse as form data: URLSearchParams encodes spaces as '+', which
// decodeURIComponent does not reverse.
const smsBody = smsCalls[0] && new URLSearchParams(smsCalls[0].body).get('Body');
check('message body is the agreed wording',
  smsBody === 'A lead has sent you a message via jessicakortum.com, navigate to jessicakortum.com/admin',
  JSON.stringify(smsBody));
check('no lead details leak into the text',
  smsCalls.every(c => !/Dana|d%40e\.com|8135550142/.test(c.body)));

// A bot tripping the honeypot must not wake anyone up at 3am.
smsCalls = []; ctx = capturingCtx();
await worker.fetch(req('/api/contact', 'POST', { ...goodLead, botcheck: '1' }), smsEnv(), ctx);
await ctx.settle();
check('honeypot hit sends no text', smsCalls.length === 0, 'sent ' + smsCalls.length);

// Invalid submissions must not either.
smsCalls = []; ctx = capturingCtx();
await worker.fetch(req('/api/contact', 'POST', { name:'', email:'bad', phone:'1' }), smsEnv(), ctx);
await ctx.settle();
check('invalid submission sends no text', smsCalls.length === 0, 'sent ' + smsCalls.length);

// Unconfigured must be silent, not broken.
smsCalls = []; ctx = capturingCtx();
smsRes = await worker.fetch(req('/api/contact', 'POST', goodLead), { ...staticEnv(), DB: smsDb }, ctx);
await ctx.settle();
check('no credentials -> no text, still 200', smsCalls.length === 0 && smsRes.status === 200);

// Twilio being down must never cost us the lead.
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('api.twilio.com')) return new Response('boom', { status: 500 });
  return new Response('{"success":true}', { status: 200 });
};
ctx = capturingCtx();
smsRes = await worker.fetch(req('/api/contact', 'POST', goodLead), smsEnv(), ctx);
await ctx.settle();
check('Twilio failure still returns success to the visitor', smsRes.status === 200, 'got ' + smsRes.status);

globalThis.fetch = savedFetch;

/* ------------------------------------------------------------------ */
console.log('\n8. transport security');

const insecure = await worker.fetch(new Request('http://x.com/'), staticEnv());
check('http:// is redirected', insecure.status === 301, 'got ' + insecure.status);
check('redirect target is https',
  (insecure.headers.get('location') || '').startsWith('https://x.com/'),
  insecure.headers.get('location'));

const secureRes = await worker.fetch(req('/'), staticEnv());
for (const h of ['strict-transport-security', 'x-content-type-options',
                 'referrer-policy', 'x-frame-options', 'permissions-policy']) {
  check('sets ' + h, !!secureRes.headers.get(h), 'missing');
}
check('nosniff value', secureRes.headers.get('x-content-type-options') === 'nosniff');
check('HSTS covers subdomains',
  (secureRes.headers.get('strict-transport-security') || '').includes('includeSubDomains'),
  secureRes.headers.get('strict-transport-security'));
// preload is a months-to-reverse commitment; assert we have NOT opted in
check('HSTS does not claim preload',
  !(secureRes.headers.get('strict-transport-security') || '').includes('preload'));

// Shareable section URLs for link-in-bio tools that drop #fragments.
for (const [path, target] of [['/contact', '/#contact'], ['/about', '/#about'],
                              ['/area', '/#area'], ['/process', '/#process'],
                              ['/families', '/#families'], ['/schools', '/#families'],
                              ['/contact/', '/#contact'], ['/CONTACT', '/#contact']]) {
  const r = await worker.fetch(req(path), staticEnv());
  const loc = r.headers.get('location') || '';
  check(path.padEnd(11) + ' -> ' + target, r.status === 302 && loc.endsWith(target),
    r.status + ' ' + loc);
}
// Must not shadow the public form endpoint.
const stillPost = await worker.fetch(
  req('/api/contact', 'POST', { name: '', email: 'bad', phone: '1' }),
  { ...staticEnv(), DB: { prepare: stmt } }
);
check('/api/contact is untouched by /contact', stillPost.status === 400, 'got ' + stillPost.status);

const apiRes = await worker.fetch(req('/api/nope'), staticEnv());
check('API responses are secured too', !!apiRes.headers.get('x-content-type-options'));

const csp = secureRes.headers.get('content-security-policy') || '';
check('CSP is enforcing, not report-only',
  !!csp && !secureRes.headers.get('content-security-policy-report-only'));
check('CSP cannot be framed', csp.includes("frame-ancestors 'none'"));
check('CSP pins form-action', csp.includes("form-action 'self'"));
// Hosts the live page genuinely needs - verified against the report-only pass.
for (const host of ['https://unpkg.com', 'https://fonts.gstatic.com',
                    'https://*.basemaps.cartocdn.com', 'https://static.cloudflareinsights.com']) {
  check('CSP allows ' + host, csp.includes(host));
}

globalThis.fetch = realFetch;
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
