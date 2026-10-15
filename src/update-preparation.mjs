import { randomUUID } from 'node:crypto';

// The main process asks the trusted renderer to save before an update can quit.
export function createUpdatePreparation({ send, timeoutMs = 15000 } = {}) {
  let pending = null;
  function finish(ok) {
    if (!pending) return;
    const current = pending; pending = null;
    clearTimeout(current.timer);
    current.resolve(ok);
  }
  function request() {
    if (pending) return pending.promise;
    const id = randomUUID();
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending = { id, promise, resolve, timer: setTimeout(() => finish(false), timeoutMs) };
    try { send({ id }); } catch { finish(false); }
    return promise;
  }
  function complete(value) {
    if (!pending || value?.id !== pending.id || typeof value.ok !== 'boolean') return false;
    finish(value.ok);
    return true;
  }
  return { request, complete, dispose: () => finish(false) };
}
