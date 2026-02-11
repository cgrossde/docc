import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DB_DIR, 'docc.db');

export { DB_PATH };

let _db;

export function getDb() {
  if (_db) return _db;
  mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      folder TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS centroids (
      folder TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      doc_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bayes_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Add embedding_raw column if it doesn't exist (nullable, no migration needed)
  try {
    _db.exec('ALTER TABLE documents ADD COLUMN embedding_raw BLOB');
  } catch {
    // Column already exists — ignore
  }

  return _db;
}

// --- Documents ---

export function insertDoc(path, folder, text, embedding, embeddingRaw) {
  const db = getDb();
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const bufRaw = embeddingRaw
    ? Buffer.from(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength)
    : null;
  db.prepare(
    'INSERT OR REPLACE INTO documents (path, folder, text, embedding, embedding_raw) VALUES (?, ?, ?, ?, ?)'
  ).run(path, folder, text, buf, bufRaw);
}

export function docExists(path) {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM documents WHERE path = ?').get(path);
  return !!row;
}

export function getAllDocs() {
  const db = getDb();
  const rows = db.prepare('SELECT id, path, folder, text, embedding, embedding_raw FROM documents').all();
  return rows.map(r => ({
    ...r,
    embedding: new Float64Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 8),
    embeddingRaw: r.embedding_raw
      ? new Float64Array(r.embedding_raw.buffer, r.embedding_raw.byteOffset, r.embedding_raw.byteLength / 8)
      : null,
  }));
}

export function getDocsByFolder(folder) {
  const db = getDb();
  const rows = db.prepare('SELECT id, path, folder, text, embedding, embedding_raw FROM documents WHERE folder = ?').all(folder);
  return rows.map(r => ({
    ...r,
    embedding: new Float64Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 8),
    embeddingRaw: r.embedding_raw
      ? new Float64Array(r.embedding_raw.buffer, r.embedding_raw.byteOffset, r.embedding_raw.byteLength / 8)
      : null,
  }));
}

// --- Centroids ---

export function upsertCentroid(folder, embedding, docCount) {
  const db = getDb();
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.prepare(
    'INSERT OR REPLACE INTO centroids (folder, embedding, doc_count) VALUES (?, ?, ?)'
  ).run(folder, buf, docCount);
}

export function getAllCentroids() {
  const db = getDb();
  const rows = db.prepare('SELECT folder, embedding, doc_count FROM centroids').all();
  return rows.map(r => ({
    folder: r.folder,
    embedding: new Float64Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 8),
    docCount: r.doc_count,
  }));
}

// --- Bayes State ---

export function saveBayesState(stateJson) {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO bayes_state (id, state) VALUES (1, ?)'
  ).run(stateJson);
}

export function loadBayesState() {
  const db = getDb();
  const row = db.prepare('SELECT state FROM bayes_state WHERE id = 1').get();
  return row ? row.state : null;
}

// --- Meta ---

export function setMeta(key, value) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getMeta(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function hasModel() {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM documents LIMIT 1').get();
  return !!row;
}

export function clearModel() {
  const db = getDb();
  db.exec("DELETE FROM documents; DELETE FROM centroids; DELETE FROM bayes_state; DELETE FROM meta WHERE key = 'embed_model';");
}
