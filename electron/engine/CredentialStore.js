'use strict';

const fsp = require('fs/promises');

// Secrets (saved logins, browser cookies passed with a download) are kept out
// of downloads.json. Values are encrypted with the supplied functions; the
// app passes Electron safeStorage (DPAPI on Windows), tests pass identity.
class CredentialStore {
  constructor(file, { encrypt = (s) => s, decrypt = (s) => s } = {}) {
    this.file = file;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.entries = {};
    this.cache = new Map();
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      this.entries = JSON.parse(await fsp.readFile(this.file, 'utf8')).entries || {};
    } catch {
      this.entries = {};
    }
    return this;
  }

  get(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const stored = this.entries[key];
    let value = null;
    if (stored) {
      try {
        value = JSON.parse(this.decrypt(stored));
      } catch {
        value = null;
      }
    }
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (value == null) {
      delete this.entries[key];
      this.cache.delete(key);
    } else {
      this.entries[key] = this.encrypt(JSON.stringify(value));
      this.cache.set(key, value);
    }
    return this.save();
  }

  deletePrefix(prefix) {
    for (const key of Object.keys(this.entries)) {
      if (key.startsWith(prefix)) {
        delete this.entries[key];
        this.cache.delete(key);
      }
    }
    return this.save();
  }

  save() {
    const data = JSON.stringify({ entries: this.entries }, null, 2);
    this.writing = this.writing
      .then(async () => {
        const temp = `${this.file}.${process.pid}.tmp`;
        await fsp.writeFile(temp, data, { mode: 0o600 });
        await fsp.rename(temp, this.file);
      })
      .catch(() => {});
    return this.writing;
  }
}

// "scheme://host:port" — the key under which a site's login is remembered.
function siteKey(url) {
  try {
    const u = new URL(url);
    return `site:${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

module.exports = { CredentialStore, siteKey };
