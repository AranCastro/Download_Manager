'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isNewer } = require('../electron/updater');

test('release versions are compared numerically', () => {
  assert.equal(isNewer('1.3.0', '1.2.1'), true);
  assert.equal(isNewer('v1.10.0', '1.9.3'), true);
  assert.equal(isNewer('1.2.1', '1.2.1'), false);
  assert.equal(isNewer('1.2.0', '1.2.1'), false);
  assert.equal(isNewer('2.0', '1.99.99'), true);
  assert.equal(isNewer('1.3.0-beta.1', '1.3.0'), false);
});
