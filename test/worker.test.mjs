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
// Assert what was created, not how many - a count breaks every time the
// schema legitimately grows.
check('leads indexes were created',
  executed.filter((s) => s.startsWith('CREATE INDEX')).length >= 2,
  executed.filter((s) => s.startsWith('CREATE INDEX')).join(' | '));
check('campaigns table is created alongside',
  executed.some((s) => s.startsWith('CREATE TABLE')) &&
  executed.filter((s) => s.startsWith('CREATE TABLE')).length >= 2,
  executed.filter((s) => s.startsWith('CREATE TABLE')).join(' | '));

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

// Stage moves are logged by the server. Everything Analytics says about how
// long a deal took rests on these entries existing.
const stageDb = (currentStatus) => ({ prepare: (sql) => ({
  _sql: sql,
  bind(...a){ this._binds = a; return this; },
  first: async () => ({ status: currentStatus, activity: '[]' }),
  run: async function(){
    if (/UPDATE/i.test(this._sql)) storedActivity = this._binds.find(b => typeof b === 'string' && b.startsWith('['));
    return { meta: { changes: 1 } };
  },
  all: async () => ({ results: [] })
}) });

storedActivity = null;
r2 = await worker.fetch(
  authReq('/api/leads/abc', 'PATCH', { status:'under_contract' }), authEnv(stageDb('contacted')));
check('stage move -> 200', r2.status === 200, 'got ' + r2.status);
const stageLog = JSON.parse(storedActivity || '[]');
check('a stage move writes a log entry',
  stageLog[0]?.type === 'stage' && /Under Contract/.test(stageLog[0].text), storedActivity);
// Analytics reads `to`, never the prose - renaming a stage must not break it.
check('the entry carries the stage ids, not just words',
  stageLog[0]?.to === 'under_contract' && stageLog[0]?.from === 'contacted', storedActivity);
check('stamped with a server time', !Number.isNaN(Date.parse(stageLog[0]?.at)));

storedActivity = null;
r2 = await worker.fetch(
  authReq('/api/leads/abc', 'PATCH', { status:'contacted' }), authEnv(stageDb('contacted')));
check('re-saving the same stage logs nothing', !storedActivity, String(storedActivity));

// Full-form saves send every field at once; the log must not double up.
storedActivity = null;
r2 = await worker.fetch(authReq('/api/leads/abc', 'PATCH', {
  status:'closed', activityAppend:{ type:'note', text:'Keys handed over' }
}), authEnv(stageDb('under_contract')));
const bothLog = JSON.parse(storedActivity || '[]');
check('a move logged alongside a note keeps both', bothLog.length === 2, storedActivity);
check('the typed note stays on top',
  bothLog[0]?.text === 'Keys handed over' && bothLog[1]?.type === 'stage', storedActivity);

// 'stage' is the server's to write, not something a client may forge.
r2 = await worker.fetch(
  authReq('/api/leads/abc', 'PATCH', { activityAppend:{ type:'stage', text:'Moved to Closed' } }),
  authEnv(stageDb('new')));
check('a client cannot post a fake stage entry', r2.status === 400, 'got ' + r2.status);

const missingLead = { prepare: () => ({ bind(){ return this; },
  first: async () => null, run: async () => ({ meta:{ changes:0 } }), all: async () => ({ results: [] }) }) };
r2 = await worker.fetch(authReq('/api/leads/nope', 'PATCH', { status:'closed' }), authEnv(missingLead));
check('moving a lead that is not there -> 404', r2.status === 404, 'got ' + r2.status);

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
console.log('\n6b. campaigns: auth, validation, fair-housing warnings');

const campRows = [];
const campDb = { prepare: (sql) => ({
  bind(...a){ this.args = a; return this; },
  run: async () => { if (/^\s*INSERT INTO campaigns/i.test(sql)) campRows.push(this?.args); return { meta:{ changes:1 } }; },
  all: async () => ({ results: [
    { id:'c1', name:'Spring sellers', slug:'spring-sellers-a1b2', channel:'facebook',
      objective:'sellers', status:'running', audience:'Homeowners weighing a move',
      geo:'Tampa + 20mi', creative:'Thinking of selling?', notes:'', budget:500, spend:250,
      starts_on:'', ends_on:'', created_at:'2026-08-01T00:00:00Z', updated_at:'2026-08-01T00:00:00Z',
      leads:10, qualified:4, closed:1 }
  ] }),
  first: async () => null
}) };

// locked down like every other admin route
for (const [method, body] of [['GET', null], ['POST', { name:'X' }]]) {
  let r = await worker.fetch(req('/api/campaigns', method, body), { ...staticEnv(), DB: campDb });
  check(method + ' /api/campaigns -> 503 unconfigured', r.status === 503, 'got ' + r.status);
  r = await worker.fetch(req('/api/campaigns', method, body), authEnv(campDb));
  check(method + ' /api/campaigns -> 401 without token', r.status === 401, 'got ' + r.status);
}

let cRes = await worker.fetch(authReq('/api/campaigns'), authEnv(campDb));
let cBody = await cRes.json();
check('GET /api/campaigns -> 200 with token', cRes.status === 200, 'got ' + cRes.status);
check('returns attribution counts',
  cBody.campaigns?.[0]?.leads === 10 && cBody.campaigns[0].closed === 1,
  JSON.stringify(cBody.campaigns?.[0]));

for (const [label, body, expected] of [
  ['no name',          { channel:'facebook' },                 400],
  ['bad channel',      { name:'X', channel:'tiktok-ads' },      400],
  ['bad objective',    { name:'X', objective:'everyone' },      400],
  ['bad date',         { name:'X', starts_on:'next tuesday' },  400],
  ['bad budget',       { name:'X', budget:'lots' },             400],
  ['valid',            { name:'Spring sellers', channel:'facebook', objective:'sellers',
                         budget:'500', geo:'Tampa + 20mi' },    200]
]) {
  const r = await worker.fetch(authReq('/api/campaigns', 'POST', body), authEnv(campDb));
  check('create: ' + label.padEnd(14) + ' -> ' + expected, r.status === expected, 'got ' + r.status);
}

// A campaign written in terms of people, not places, must be flagged.
const flagged = await worker.fetch(authReq('/api/campaigns', 'POST', {
  name: 'Test', channel: 'facebook',
  audience: 'Young married couples with children looking for their first family home'
}), authEnv(campDb));
const flaggedBody = await flagged.json();
check('protected-class wording is flagged',
  Array.isArray(flaggedBody.warnings) && flaggedBody.warnings.length >= 3,
  JSON.stringify(flaggedBody.warnings));
check('but the campaign still saves (warn, never block)', flagged.status === 200, 'got ' + flagged.status);

const clean = await worker.fetch(authReq('/api/campaigns', 'POST', {
  name: 'Geo only', channel: 'facebook',
  audience: 'Homeowners in South Tampa considering a move this year',
  geo: 'Tampa + 20 mile radius'
}), authEnv(campDb));
check('neutral wording produces no warnings',
  ((await clean.json()).warnings || []).length === 0);

// mailer export
const mail = await worker.fetch(authReq('/api/mailer'), authEnv(campDb));
check('GET /api/mailer -> csv', mail.headers.get('content-type')?.includes('text/csv'),
  mail.headers.get('content-type'));
const mailUnauth = await worker.fetch(req('/api/mailer'), authEnv(campDb));
check('mailer is auth-gated', mailUnauth.status === 401, 'got ' + mailUnauth.status);

/* ------------------------------------------------------------------ */
console.log('\n6c. campaign attribution on the public form');

let capturedInsert = null;
const attrDb = { prepare: (sql) => ({
  bind(...a){ if (/INSERT INTO leads/i.test(sql)) capturedInsert = { sql, args: a }; return this; },
  run: async () => ({ meta:{ changes:1 } }),
  all: async () => ({ results: [] })
}) };
const savedFetch2 = globalThis.fetch;
globalThis.fetch = async () => new Response('{"success":true}', { status: 200 });
await worker.fetch(req('/api/contact','POST',{
  name:'Dana', email:'d@e.com', phone:'8135550142', intent:'Buy', message:'hi',
  campaign:'spring-sellers-a1b2'
}), { ...staticEnv(), DB: attrDb });
globalThis.fetch = savedFetch2;
check('utm_campaign is stored with the lead',
  capturedInsert && capturedInsert.args.includes('spring-sellers-a1b2'),
  JSON.stringify(capturedInsert && capturedInsert.args));

globalThis.fetch = async () => new Response('{"success":true}', { status: 200 });
capturedInsert = null;
await worker.fetch(req('/api/contact','POST',{
  name:'Dana', email:'d@e.com', phone:'8135550142', intent:'Buy', message:'hi',
  campaign:'<script>alert(1)</script>'
}), { ...staticEnv(), DB: attrDb });
globalThis.fetch = savedFetch2;
check('campaign value is sanitised to slug characters',
  capturedInsert && !capturedInsert.args.some(a => String(a).includes('<')),
  JSON.stringify(capturedInsert && capturedInsert.args));

/* ------------------------------------------------------------------ */
console.log('\n6d. tasks: auth, validation, batches, completion stamp');

let taskSql = [];
const taskDb = { prepare: (sql) => {
  taskSql.push(sql);
  return {
    bind(...a){ this.args = a; taskSql[taskSql.length - 1] = { sql, args: a }; return this; },
    run: async () => ({ meta:{ changes: /WHERE id = \?$/.test(sql) && this?.args?.[this.args.length-1] === 'missing' ? 0 : 1 } }),
    all: async () => ({ results: [
      { id:'t1', title:'Call the Whitfields back', notes:'', status:'todo', priority:'high',
        assignee:'Jessica', due_on:'2026-08-20', lead_id:'l1', campaign_id:'',
        created_at:'2026-08-18T00:00:00Z', updated_at:'2026-08-18T00:00:00Z', completed_at:'',
        lead_name:'Dana Whitfield', campaign_name:null }
    ] }),
    first: async () => null
  };
} };

// Same lock as every other admin route.
for (const [method, body] of [['GET', null], ['POST', { title:'X' }]]) {
  let r = await worker.fetch(req('/api/tasks', method, body), { ...staticEnv(), DB: taskDb });
  check(method + ' /api/tasks -> 503 unconfigured', r.status === 503, 'got ' + r.status);
  r = await worker.fetch(req('/api/tasks', method, body), authEnv(taskDb));
  check(method + ' /api/tasks -> 401 without token', r.status === 401, 'got ' + r.status);
}
for (const method of ['PATCH', 'DELETE']) {
  const r = await worker.fetch(req('/api/tasks/t1', method, { status:'done' }), authEnv(taskDb));
  check(method + ' /api/tasks/:id -> 401 without token', r.status === 401, 'got ' + r.status);
}
const taskBadMethod = await worker.fetch(authReq('/api/tasks', 'PUT', {}), authEnv(taskDb));
check('PUT /api/tasks -> 405', taskBadMethod.status === 405, 'got ' + taskBadMethod.status);

let tRes = await worker.fetch(authReq('/api/tasks'), authEnv(taskDb));
let tBody = await tRes.json();
check('GET /api/tasks -> 200 with token', tRes.status === 200, 'got ' + tRes.status);
check('the linked lead name comes back with the task',
  tBody.tasks?.[0]?.lead_name === 'Dana Whitfield', JSON.stringify(tBody.tasks?.[0]));
// A task must outlive the lead it pointed at, so the joins have to be LEFT.
const listSql = taskSql.map((s) => (typeof s === 'string' ? s : s.sql)).find((s) => /FROM tasks/i.test(s));
check('list uses LEFT JOIN so deleting a lead cannot hide tasks',
  /LEFT JOIN leads/i.test(listSql) && /LEFT JOIN campaigns/i.test(listSql), listSql);

for (const [label, body, expected] of [
  ['no title',      { notes:'x' },                            400],
  ['blank title',   { title:'   ' },                          400],
  ['bad status',    { title:'X', status:'someday' },          400],
  ['bad priority',  { title:'X', priority:'urgent' },         400],
  ['bad due date',  { title:'X', due_on:'next tuesday' },     400],
  ['valid',         { title:'Order the survey', status:'todo', priority:'high',
                      assignee:'Jessica', due_on:'2026-08-25', lead_id:'l1' }, 200]
]) {
  const r = await worker.fetch(authReq('/api/tasks', 'POST', body), authEnv(taskDb));
  check('create: ' + label.padEnd(12) + ' -> ' + expected, r.status === expected, 'got ' + r.status);
}

// The whole point of a workflow template: one request, the whole job.
taskSql = [];
const batch = await worker.fetch(authReq('/api/tasks', 'POST', {
  tasks: Array.from({ length: 10 }, (_, i) => ({ title: 'Step ' + i, due_on: '2026-09-0' + (i % 9) }))
}), authEnv(taskDb));
check('a batch of 10 creates 10', (await batch.json()).created === 10, 'got ' + batch.status);
const inserts = taskSql.filter((s) => /INSERT INTO tasks/i.test(typeof s === 'string' ? s : s.sql));
check('one INSERT per task in the batch', inserts.length === 10, 'got ' + inserts.length);
// The bug class that has bitten this file before: a column added without a
// matching placeholder or bind.
const ins = inserts[0];
const cols = ins.sql.match(/INSERT INTO tasks\s*\(([\s\S]*?)\)\s*VALUES/i)[1].split(',').length;
const marks = (ins.sql.match(/\?/g) || []).length;
check('INSERT columns, placeholders and binds agree',
  cols === marks && marks === ins.args.length, cols + '/' + marks + '/' + ins.args.length);

// One malformed entry must not leave half a workflow behind.
taskSql = [];
const halfBad = await worker.fetch(authReq('/api/tasks', 'POST', {
  tasks: [{ title:'Fine' }, { title:'Also fine', status:'nonsense' }]
}), authEnv(taskDb));
check('a bad entry rejects the whole batch', halfBad.status === 400, 'got ' + halfBad.status);
check('and writes nothing',
  !taskSql.some((s) => /INSERT INTO tasks/i.test(typeof s === 'string' ? s : s.sql)));

const tooMany = await worker.fetch(authReq('/api/tasks', 'POST', {
  tasks: Array.from({ length: 41 }, (_, i) => ({ title: 'Step ' + i }))
}), authEnv(taskDb));
check('an absurd batch is refused', tooMany.status === 400, 'got ' + tooMany.status);

// Finishing a task stamps it; reopening one clears the stamp.
const stampOf = async (status) => {
  taskSql = [];
  await worker.fetch(authReq('/api/tasks/t1', 'PATCH', { status }), authEnv(taskDb));
  const upd = taskSql.find((s) => /UPDATE tasks/i.test(typeof s === 'string' ? s : s.sql));
  const at = upd.sql.split('SET ')[1].split(/,\s*/).findIndex((f) => /completed_at/.test(f));
  return { sql: upd.sql, value: upd.args[at] };
};
const doneStamp = await stampOf('done');
check('finishing a task records when', /completed_at = \?/.test(doneStamp.sql) && !!doneStamp.value,
  JSON.stringify(doneStamp));
const reopened = await stampOf('todo');
check('reopening one clears it', reopened.value === '', JSON.stringify(reopened));

taskSql = [];
await worker.fetch(authReq('/api/tasks/t1', 'PATCH', { notes:'called, left a message' }), authEnv(taskDb));
const notesUpd = taskSql.find((s) => /UPDATE tasks/i.test(typeof s === 'string' ? s : s.sql));
check('a patch touches only the fields it was given',
  /SET notes = \?, updated_at = \?/.test(notesUpd.sql), notesUpd.sql);
check('and never stamps completed_at by accident',
  !/completed_at/.test(notesUpd.sql), notesUpd.sql);

const emptyPatch = await worker.fetch(authReq('/api/tasks/t1', 'PATCH', {}), authEnv(taskDb));
check('an empty patch is a 400, not a silent no-op', emptyPatch.status === 400, 'got ' + emptyPatch.status);
const blankTitle = await worker.fetch(authReq('/api/tasks/t1', 'PATCH', { title:'  ' }), authEnv(taskDb));
check('a task cannot be renamed to nothing', blankTitle.status === 400, 'got ' + blankTitle.status);

const gone = { prepare: () => ({ bind(){ return this; },
  run: async () => ({ meta:{ changes: 0 } }), all: async () => ({ results: [] }) }) };
for (const method of ['PATCH', 'DELETE']) {
  const r = await worker.fetch(authReq('/api/tasks/missing', method, { status:'done' }), authEnv(gone));
  check(method + ' a task that is not there -> 404', r.status === 404, 'got ' + r.status);
}
const del = await worker.fetch(authReq('/api/tasks/t1', 'DELETE'), authEnv(taskDb));
check('DELETE /api/tasks/:id -> 200', del.status === 200, 'got ' + del.status);

// Long free text is truncated rather than rejected - losing what someone typed
// is worse than storing a shortened version of it.
taskSql = [];
await worker.fetch(authReq('/api/tasks', 'POST', {
  title: 'T'.repeat(500), notes: 'N'.repeat(9000), assignee: 'A'.repeat(400)
}), authEnv(taskDb));
const longIns = taskSql.find((s) => /INSERT INTO tasks/i.test(typeof s === 'string' ? s : s.sql));
check('over-long fields are capped, not refused',
  longIns.args[1].length === 200 && longIns.args[2].length === 4000 && longIns.args[5].length === 80,
  [longIns.args[1].length, longIns.args[2].length, longIns.args[5].length].join('/'));

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

// www must fold into the apex, and do it in one hop from http.
for (const [from, expected] of [
  ['https://www.jessicakortum.com/',            'https://jessicakortum.com/'],
  ['http://www.jessicakortum.com/contact',      'https://jessicakortum.com/contact'],
  ['https://www.jessicakortum.com/?a=1',        'https://jessicakortum.com/?a=1']
]) {
  const r = await worker.fetch(new Request(from), staticEnv());
  check('www -> apex: ' + from.replace('https://www.jessicakortum.com','').replace('http://www.jessicakortum.com','http:'),
    r.status === 301 && r.headers.get('location') === expected,
    r.status + ' ' + r.headers.get('location'));
}
// the apex itself must not be caught by the www rule
const apex = await worker.fetch(req('/'), staticEnv());
check('apex is served, not redirected', apex.status === 200, 'got ' + apex.status);

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
