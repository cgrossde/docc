# CLAUDE.md

## Project Overview

**docc** — a CLI tool that classifies PDFs into folders. It learns from an existing organized folder structure, then predicts where new PDFs belong. Plain JavaScript (ESM), no build step.

## Key Commands

```bash
docc setup              # Install Ollama, pull model, configure paths
docc config             # View/set root and inbox paths
docc learn [folder]     # Index PDFs (default: configured root)
docc classify <pdf>     # Classify a single PDF, show ranked folders
docc test               # Leave-one-out cross-validation accuracy report
docc ui [folder]        # Web UI to classify PDFs (default: configured inbox or cwd)
docc reset              # Clear learned model (preserves configuration)
```

## Architecture

Two classifiers combined via Reciprocal Rank Fusion (RRF, k=5):
- **Embedding centroids** — cosine similarity against per-folder centroid vectors (Ollama `qwen3-embedding:0.6b`, 1024-dim)
- **Naive Bayes** — multinomial text classifier on tokenized document text

See `ARCHITECTURE.md` for full details.

## Project Structure

```
bin/docc.js          CLI entry point (commander), all 7 commands
lib/
  db.js              SQLite schema + query helpers (better-sqlite3), clearModel()
  pdf.js             PDF text extraction (unpdf), suppresses PDF.js warnings
  embedder.js        Ollama REST API client, auto-truncates on context overflow
  bayes.js           Naive Bayes with EN+DE stopwords, Unicode-aware tokenizer
  vectors.js         Cosine similarity, centroid math, leave-one-out adjustment, duplicate detection
  classifier.js      RRF score fusion, returns ranked results with per-method detail
  folders.js         Recursive folder scanner, skips root-level PDFs
  ui.js              Web UI server + inline SPA (classification, duplicate detection, compare view, keyboard-driven)
data/
  docc.db            SQLite database (created at runtime, gitignored)
```

## Dependencies

- `commander` v14 — CLI framework
- `unpdf` v1.4 — PDF text extraction (wraps PDF.js)
- `better-sqlite3` v12 — SQLite persistence
- Ollama (local) — embedding via `POST http://localhost:11434/api/embed`

## Important Patterns

- **ESM only** — `"type": "module"` in package.json, use `import`/`export`
- **German + English** — tokenizer uses Unicode regex (`\p{L}\p{N}`), stopword list covers both languages
- **Embedder retries** — truncates text at 24000/12000/4000 chars on context-length errors from Ollama
- **PDF.js warnings suppressed** — `lib/pdf.js` filters font/glyph/cMap warnings during extraction
- **Embeddings stored as blobs** — `Float64Array` buffers in SQLite (1024 doubles = 8,192 bytes each)
- **RRF k=5** — tuned for small category counts (10–50 folders), not the web-search default of k=60
- **Confidence scoring** — RRF rank score normalized against theoretical max, then scaled by embedding cosine similarity so poor fits show low percentages even when ranked #1
- **Duplicate detection** — `findDuplicates()` in vectors.js compares inbox PDF embedding against all stored docs; threshold 0.985 cosine similarity catches OCR re-scans. Shown as non-blocking hint above suggestions.
- **Configurable suggestion count** — `NUM_SUGGESTIONS` constant in the SPA (currently 4); shortcuts, fuzzy-key, and UI adapt dynamically
- **Compare view** — side-by-side PDF comparison (inbox left, existing right) from duplicate warnings or by clicking any file in the folder file list
- **Console logging** — all user actions (classify, move, skip, delete, duplicate detection) logged to the terminal for audit
- **Filename enrichment** — `enrichText()` in pdf.js prepends `[File: name]` to extracted text before embedding/classification, adding classification signal from filenames
- **Model mismatch detection** — `embed_model` stored in meta table; learn/classify/test/ui refuse to run if stored model differs from current `EMBED_MODEL`
- **Config in meta table** — `root` (doc directory), `inbox` (unclassified PDFs), and `embed_model` stored as meta keys; `reset` clears model + embed_model but preserves config
- **`learn` and `ui` use stored paths** — `learn` falls back to stored `root`, `ui` falls back to stored `inbox` then cwd

## Running

```bash
npm install
npm link        # makes `docc` available globally
docc setup      # one-time Ollama setup
```

## No Tests

There is no test suite. The `docc test` command is the validation mechanism (leave-one-out on real data).
