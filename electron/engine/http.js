'use strict';

const crypto = require('crypto');

// Raised when a server needs credentials we do not have (or rejected the ones
// we sent). The download moves to the "auth-required" state.
class AuthRequiredError extends Error {
  constructor(realm, detail) {
    super(detail || (realm ? `Login required: ${realm}` : 'Login required'));
    this.authRequired = true;
    this.fatal = true;
    this.realm = realm || null;
  }
}

class HttpError extends Error {
  constructor(status, statusText) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.status = status;
    // 4xx responses (except timeouts / rate limits) will not succeed on retry.
    this.fatal = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

// Parses a WWW-Authenticate header, preferring Digest over Basic when the
// server offers both.
function parseChallenge(header) {
  if (!header) return null;
  const starts = [...header.matchAll(/(?:^|,)\s*(Basic|Digest)\s+/gi)];
  const challenges = starts.map((m, i) => {
    const from = m.index + m[0].length;
    const to = i + 1 < starts.length ? starts[i + 1].index : header.length;
    const params = {};
    for (const p of header.slice(from, to).matchAll(/([\w-]+)\s*=\s*("((?:\\.|[^"\\])*)"|[^,\s]*)/g)) {
      params[p[1].toLowerCase()] = p[3] !== undefined ? p[3].replace(/\\(.)/g, '$1') : p[2];
    }
    return { scheme: m[1].toLowerCase(), params };
  });
  return challenges.find((c) => c.scheme === 'digest') || challenges[0] || null;
}

// Holds the server's last challenge for one download and builds the
// Authorization header for each request (RFC 7617 Basic, RFC 7616 Digest).
class AuthSession {
  constructor(getCredentials) {
    this.getCredentials = getCredentials;
    this.challenge = null;
    this.nonceCount = 0;
  }

  credentials() {
    return this.getCredentials() || null;
  }

  header(method, url) {
    const creds = this.credentials();
    if (!creds || !this.challenge) return null;
    if (this.challenge.scheme === 'basic') {
      return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
    }
    return this.digestHeader(creds, method, url);
  }

  digestHeader({ username, password }, method, url) {
    const p = this.challenge.params;
    const algorithm = (p.algorithm || 'MD5').toUpperCase();
    const hashName = algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
    const H = (s) => crypto.createHash(hashName).update(s).digest('hex');
    const { pathname, search } = new URL(url);
    const uri = pathname + search;
    const cnonce = crypto.randomBytes(8).toString('hex');
    const nc = (++this.nonceCount).toString(16).padStart(8, '0');
    let ha1 = H(`${username}:${p.realm}:${password}`);
    if (algorithm.endsWith('-SESS')) ha1 = H(`${ha1}:${p.nonce}:${cnonce}`);
    const ha2 = H(`${method}:${uri}`);
    const qop = (p.qop || '').split(',').map((q) => q.trim()).includes('auth') ? 'auth' : null;
    const response = qop ? H(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${p.nonce}:${ha2}`);
    const parts = [
      `username="${username}"`,
      `realm="${p.realm}"`,
      `nonce="${p.nonce}"`,
      `uri="${uri}"`,
      `algorithm=${p.algorithm || 'MD5'}`,
      `response="${response}"`,
    ];
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    if (p.opaque) parts.push(`opaque="${p.opaque}"`);
    return `Digest ${parts.join(', ')}`;
  }
}

// fetch() with login handling: a 401 is answered once with the stored
// credentials; without credentials (or when they are rejected) it throws
// AuthRequiredError so the user can be asked.
async function request(url, { headers = {}, signal, auth, method = 'GET' } = {}) {
  let sentAuth = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const finalHeaders = { ...headers };
    const authorization = auth?.header(method, url);
    if (authorization) {
      finalHeaders.Authorization = authorization;
      sentAuth = true;
    }
    const res = await fetch(url, { method, headers: finalHeaders, signal, redirect: 'follow' });
    if (res.status !== 401 || !auth) return res;

    await res.body?.cancel().catch(() => {});
    const challenge = parseChallenge(res.headers.get('www-authenticate'));
    const realm = challenge?.params.realm;
    if (!challenge) throw new AuthRequiredError(realm, 'Server requires a login method that is not supported');
    const stale = String(challenge.params.stale).toLowerCase() === 'true';
    if (!auth.credentials()) throw new AuthRequiredError(realm);
    if (sentAuth && !stale) throw new AuthRequiredError(realm, 'Login failed: user name or password was rejected');
    auth.challenge = challenge;
    auth.nonceCount = 0;
  }
  throw new AuthRequiredError(auth?.challenge?.params.realm);
}

// fetch() reports network failures as "fetch failed" with the reason in .cause.
function describeError(err) {
  const cause = err?.cause;
  if (cause) return `${err.message}: ${cause.code || cause.message || cause}`;
  return err?.message || String(err);
}

module.exports = { AuthRequiredError, AuthSession, HttpError, describeError, parseChallenge, request };
