import worker from '../worker.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
};

const staticEnv = () => ({ ASSETS: { fetch: async () => new Response('STATIC-ASSET') } });

const req = (path, method = 'GET', body = null) =>
  new Request('https://x.com' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : null
  });

// ---------------------------------------------------------------- //
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

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{"success":true}', { status: 200 });

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

// ---------------------------------------------------------------- //
console.log('\n2. a real DB error is NOT mistaken for a missing table');

let attempts = 0;
const brokenDb = {
  prepare: () => ({
    bind() { return this; },
    run: async () => { attempts++; throw new Error('D1_ERROR: database is locked'); },
    all: async () => { attempts++; throw new Error('D1_ERROR: database is locked'); }
  })
};
attempts = 0;
res = await worker.fetch(
  req('/api/contact', 'POST', {
    name: 'Test', email: 'a@b.com', phone: '8135550142', intent: 'Buy', message: 'hi'
  }),
  { ...staticEnv(), DB: brokenDb }
);
check('no retry loop on unrelated errors', attempts === 1, 'attempts=' + attempts);
check('still succeeds via email fallback', res.status === 200, 'got ' + res.status);

globalThis.fetch = realFetch;

// ---------------------------------------------------------------- //
console.log('\n3. admin routes still fail closed without Access config');

res = await worker.fetch(req('/api/leads'), { ...staticEnv(), DB: { prepare: stmt } });
check('/api/leads -> 503 when unconfigured', res.status === 503, 'got ' + res.status);

res = await worker.fetch(
  req('/api/leads'),
  { ...staticEnv(), DB: { prepare: stmt }, CF_ACCESS_TEAM_DOMAIN: 't.example', CF_ACCESS_AUD: 'aud' }
);
check('/api/leads -> 401 with config but no token', res.status === 401, 'got ' + res.status);

// ---------------------------------------------------------------- //
console.log('\n4. routing and private files');

const cases = [
  ['/', 200, 'STATIC-ASSET'],
  ['/schema.sql', 404, null],
  ['/worker.js', 404, null],
  ['/wrangler.jsonc', 404, null],
  ['/functions/api/contact.js', 404, null],
  ['/api/nope', 404, null]
];
for (const [path, status] of cases) {
  const r = await worker.fetch(req(path), staticEnv());
  check(path.padEnd(28) + ' -> ' + status, r.status === status, 'got ' + r.status);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
