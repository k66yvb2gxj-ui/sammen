import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdatePreparation } from '../src/update-preparation.mjs';

test('update shutdown waits for a matching successful renderer save', async () => {
  const sent = [];
  const preparation = createUpdatePreparation({ send: value => sent.push(value) });
  const result = preparation.request();
  assert.equal(preparation.request(), result);
  assert.equal(sent.length, 1);
  assert.equal(preparation.complete({ id: 'untrusted-or-stale', ok: true }), false);
  assert.equal(preparation.complete({ id: sent[0].id, ok: 'yes' }), false);
  assert.equal(preparation.complete({ id: sent[0].id, ok: true }), true);
  assert.equal(await result, true);
  assert.equal(preparation.complete({ id: sent[0].id, ok: true }), false);
});

test('failed saves block installation and the next attempt gets a fresh request', async () => {
  const sent = [];
  const preparation = createUpdatePreparation({ send: value => sent.push(value) });
  const failed = preparation.request();
  preparation.complete({ id: sent[0].id, ok: false });
  assert.equal(await failed, false);
  const retry = preparation.request();
  assert.notEqual(sent[0].id, sent[1].id);
  assert.equal(preparation.complete({ id: sent[0].id, ok: true }), false);
  preparation.complete({ id: sent[1].id, ok: true });
  assert.equal(await retry, true);
});

test('an unresponsive or unavailable renderer cannot allow an update to quit', async () => {
  const timeout = createUpdatePreparation({ send: () => {}, timeoutMs: 5 });
  assert.equal(await timeout.request(), false);
  const missing = createUpdatePreparation({ send: () => { throw new Error('closed'); } });
  assert.equal(await missing.request(), false);
});

test('disposal cancels a pending save instead of allowing installation', async () => {
  const preparation = createUpdatePreparation({ send: () => {} });
  const result = preparation.request();
  preparation.dispose();
  assert.equal(await result, false);
});
