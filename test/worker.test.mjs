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
console.log('\n7. routing and private files');

for (const [path, status] of [
  ['/', 200], ['/schema.sql', 404], ['/worker.js', 404], ['/wrangler.jsonc', 404],
  ['/functions/api/contact.js', 404], ['/test/worker.test.mjs', 404], ['/api/nope', 404]
]) {
  const r = await worker.fetch(req(path), staticEnv());
  check(path.padEnd(28) + ' -> ' + status, r.status === status, 'got ' + r.status);
}

globalThis.fetch = realFetch;
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
