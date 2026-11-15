import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized } from '../lib/token.js';

test('accepts only the configured bearer token', () => {
  assert.equal(isAuthorized('Bearer secret-token', 'secret-token'), true);
  assert.equal(isAuthorized('Bearer other-token', 'secret-token'), false);
  assert.equal(isAuthorized('secret-token', 'secret-token'), false);
  assert.equal(isAuthorized(undefined, 'secret-token'), false);
  assert.equal(isAuthorized(['Bearer secret-token'], 'secret-token'), false);
  assert.equal(isAuthorized('Bearer secret-token\n', 'secret-token'), false);
  assert.equal(isAuthorized('Bearer\nsecret-token', 'secret-token'), false);
  assert.equal(isAuthorized('Bearer secret-token ', 'secret-token'), false);
  assert.equal(isAuthorized('bearer\tsecret-token', 'secret-token'), true);
  assert.equal(isAuthorized('Bearer secret-token', false), false);
});

test('allows requests without a configured token', () => {
  assert.equal(isAuthorized(undefined, undefined), true);
  assert.equal(isAuthorized('Bearer anything', undefined), true);
});
