'use strict';

const { sleep } = require('./utils');

// Global bandwidth limiter shared by every connection. Each consumer reserves
// a slot on a virtual clock that advances by bytes / rate, then waits until
// that slot comes due. A rate of 0 disables limiting.
class RateLimiter {
  constructor(bytesPerSecond = 0) {
    this.rate = 0;
    this.nextFree = 0;
    this.setRate(bytesPerSecond);
  }

  setRate(bytesPerSecond) {
    this.rate = Math.max(0, Number(bytesPerSecond) || 0);
    this.nextFree = 0;
  }

  async consume(bytes, signal) {
    if (!this.rate) return;
    const now = Date.now();
    this.nextFree = Math.max(this.nextFree, now);
    const wait = this.nextFree - now;
    this.nextFree += (bytes / this.rate) * 1000;
    if (wait > 0) await sleep(wait, signal);
  }
}

module.exports = { RateLimiter };
