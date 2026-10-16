import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { normalizePerson } from './people.mjs';

export const ACTIVITY_TYPES = Object.freeze(['room.created', 'member.joined', 'member.left', 'profile.updated', 'project.created', 'project.updated', 'file.created', 'file.updated', 'file.deleted']);

// This log stores only explicitly selected activity metadata, never requests or documents.
export function createAdminEvents({ filename, maxEvents = 5000 }) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 5000) throw new Error('Ugyldig grense for aktivitetsloggen.');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, brainId TEXT NOT NULL, actor TEXT NOT NULL, target TEXT);');
  function record(input) {
    if (!ACTIVITY_TYPES.includes(input.type) || typeof input.brainId !== 'string' || !input.brainId || input.brainId.length > 100) throw new Error('Ugyldig aktivitet.');
    const actor = normalizePerson(input.actor);
    let target;
    if (input.target !== undefined) {
      if (typeof input.target?.id !== 'string' || !input.target.id || input.target.id.length > 100 || typeof input.target.title !== 'string' || input.target.title.length > 200) throw new Error('Ugyldig aktivitetsmål.');
      target = { id: input.target.id, title: input.target.title };
    }
    const event = { id: randomUUID(), at: new Date().toISOString(), type: input.type, brainId: input.brainId, actor, ...(target ? { target } : {}) };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO events(id,at,type,brainId,actor,target) VALUES(?,?,?,?,?,?)').run(event.id, event.at, event.type, event.brainId, JSON.stringify(actor), target ? JSON.stringify(target) : null);
      db.prepare('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY rowid DESC LIMIT -1 OFFSET ?)').run(maxEvents);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return event;
  }
  function activity(limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Vis mellom 1 og 200 aktiviteter.');
    return db.prepare('SELECT id,at,type,brainId,actor,target FROM events ORDER BY rowid DESC LIMIT ?').all(limit).map(row => ({ id: row.id, at: row.at, type: row.type, brainId: row.brainId, actor: normalizePerson(JSON.parse(row.actor)), ...(row.target ? { target: JSON.parse(row.target) } : {}) }));
  }
  return { record, activity, lastActivity: () => new Map(db.prepare('SELECT brainId,MAX(at) AS at FROM events GROUP BY brainId').all().map(row => [row.brainId, row.at])), close: () => db.close() };
}
