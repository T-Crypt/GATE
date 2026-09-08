import { DatabaseSync } from 'node:sqlite';

const transactionState = new WeakMap();

export function openDatabase({ filename }) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return db;
}

export function withTransaction(db, operation) {
  const active = transactionState.get(db);
  if (active) return operation();

  const state = { afterCommit: [] };
  transactionState.set(db, state);
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = operation();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    transactionState.delete(db);
    throw error;
  }
  transactionState.delete(db);
  for (const callback of state.afterCommit) callback();
  return result;
}

export function afterCommit(db, callback) {
  const active = transactionState.get(db);
  if (active) active.afterCommit.push(callback);
  else callback();
}
