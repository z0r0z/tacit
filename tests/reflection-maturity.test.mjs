import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMatured } from '../worker-relay/src/lib/maturity.js';

test('a batch is matured exactly when its tip is confirmations blocks behind the relay tip', () => {
  assert.equal(isMatured(967783, 967807, 24), true);   // tip == relay - 24: the boundary lands
  assert.equal(isMatured(967782, 967807, 24), true);
  assert.equal(isMatured(967784, 967807, 24), false);  // one over
  assert.equal(isMatured(967789, 967807, 24), false);  // the incident: 6 over the matured anchor
  assert.equal(isMatured(967789, 967813, 24), true);   // lands once the relay reaches attestedTo + 24
});
test('a shallower depth does not mask an over-mature batch', () => {
  assert.equal(isMatured(967789, 967807, 6), true);    // what the stale default of 6 wrongly allowed
  assert.equal(isMatured(967789, 967807, 24), false);
});
test('garbage input fails closed', () => {
  assert.equal(isMatured(undefined, 967807, 24), false);
  assert.equal(isMatured(967783, NaN, 24), false);
  assert.equal(isMatured(967783, 967807, undefined), false);
});
