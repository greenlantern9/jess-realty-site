// Verifies the Cloudflare Access JWT that Access attaches to every request
// reaching a protected route.
//
// Why verify instead of trusting the header: if the Access policy is ever
// deleted, misconfigured, or the route pattern stops matching, the request
// would arrive unauthenticated. Verifying the signature ourselves means the
// API fails closed in that case rather than serving client data to anyone.

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

/**
 * @returns {Promise<{ok: true, email: string} | {ok: false, status: number, message: string}>}
 */
export async function requireAccess(env, request) {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const expectedAud = env.CF_ACCESS_AUD;

  // Fail closed: without config we cannot prove who the caller is.
  if (!teamDomain || !expectedAud) {
    return {
      ok: false,
      status: 503,
      message: 'Admin auth is not configured on the server.'
    };
  }

  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    readCookie(request, 'CF_Authorization');

  if (!token) {
    return { ok: false, status: 401, message: 'Not signed in.' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, status: 401, message: 'Malformed token.' };
  }

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
  if (!jwk) {
    return { ok: false, status: 401, message: 'Unknown signing key.' };
  }

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

  if (!verified) {
    return { ok: false, status: 401, message: 'Invalid token signature.' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < nowSec) {
    return { ok: false, status: 401, message: 'Session expired — reload to sign in again.' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec) {
    return { ok: false, status: 401, message: 'Token not yet valid.' };
  }

  // The audience tag pins this token to *this* Access application, so a valid
  // token minted for some other app on the same team is not accepted here.
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(expectedAud)) {
    return { ok: false, status: 401, message: 'Token audience mismatch.' };
  }

  if (payload.iss !== `https://${teamDomain}`) {
    return { ok: false, status: 401, message: 'Token issuer mismatch.' };
  }

  return { ok: true, email: payload.email || 'signed in' };
}
