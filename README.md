# docc

A CLI tool that learns how you organize your PDFs, then classifies new ones into the right folder.

Point it at your existing folder structure, let it learn the patterns, and then ask it where a new PDF belongs. Works with German and English documents. Runs entirely offline using local embeddings via [Ollama](https://ollama.com).

## Prerequisites

- **Node.js** 18+
- **Homebrew** (for automatic Ollama installation)

## Install

```bash
git clone <repo-url> && cd doc-classifier
npm install
npm link
```

This makes the `docc` command available globally.

## Setup

Run the one-time setup to install Ollama and pull the embedding model:

```bash
docc setup
# Ollama is not installed. Install via Homebrew? [y/N] y
# Installing Ollama...
# Ollama installed.
# Starting Ollama server...
# Ollama server is running.
# Pulling qwen3-embedding:0.6b model (this may take a minute on first run)...
# Pulling qwen3:1.7b model for filename suggestions...
#
# ── Configuration ──
#
# Doc directory (root folder with categorized PDFs): ./my-documents
#   Root set to /Users/you/my-documents
# Inbox folder (optional, for unclassified PDFs): /Volumes/Scanner/Inbox
#   Inbox set to /Volumes/Scanner/Inbox
#
# Setup complete. Run `docc learn` to index your documents.
```

This will install Ollama (with confirmation), start the background server, download the `qwen3-embedding:0.6b` embedding model (~640 MB) and the `qwen3:1.7b` generation model (~1.4 GB, used for filename suggestions), and prompt you to configure your document directory and inbox folder. If Ollama is already installed or the server is already running, those steps are skipped.

## Usage

### Configure paths

View or change the configured paths at any time:

```bash
docc config
# root:  /Users/you/my-documents
# inbox: /Volumes/Scanner/Inbox

docc config root /path/to/new-docs
# Root changed. This will clear the learned model. Continue? [y/N] y
# Learned model cleared.
# root set to /path/to/new-docs

docc config inbox /path/to/inbox
# inbox set to /path/to/inbox
```

Changing the root when a model is already learned will prompt to clear it, since the folder structure has changed.

### Learn from your folder structure

Organize your PDFs into subfolders by category, then teach docc the structure:

```
my-documents/
├── Invoices/
│   ├── invoice-january.pdf
│   └── invoice-february.pdf
├── Contracts/
│   └── lease-agreement.pdf
├── Medical/
│   └── lab-results.pdf
└── Financial/
    └── Tax/
        └── 2024-return.pdf
```

```bash
docc learn              # uses configured root
docc learn ./my-documents  # or specify explicitly
# Found 5 PDFs, 5 new to process.
# Processing 1/5: Invoices/invoice-january.pdf
# Processing 2/5: Invoices/invoice-february.pdf
# ...
# Learned 5 documents across 4 folders.
```

Subfolder names become categories. Nested folders work too (`Financial/Tax`). PDFs sitting directly in the root are skipped — they need a subfolder to define the category.

Each document gets two embeddings: an **enriched** one (with filename metadata, used for classification) and a **raw** one (content-only, used for duplicate detection and name similarity). This means `learn` makes two embedding calls per PDF.

Run `learn` again after adding new PDFs; already-indexed files are skipped automatically.

### Classify a new PDF

```bash
docc classify ./unsorted/mystery-document.pdf
#
# Folder                          Score
# ──────────────────────────────────────────
# 1.  Invoices                     0.42
# 2.  Receipts                     0.24
# 3.  Financial/Tax                0.15
# 4.  Contracts                    0.11
# 5.  Medical                      0.08
#
# Suggested names (date: 2024-03):
#   1. 2024-03 Jahresrechnung.pdf  (similarity 98.3%)
#   2. 2024-03 Rechnung.pdf  (llm)
#   3. 2024-03 Monatsabrechnung.pdf  (llm)
```

Filename suggestions combine two strategies: **similarity matching** (names from near-identical documents already in the target folder, compared using content-only embeddings) and **LLM generation** (via `qwen3:1.7b`). The date is extracted from the document text, filename, or file modification time.

### Test accuracy

Run leave-one-out cross-validation to see how well the model performs on your data:

```bash
docc test
# Leave-one-out accuracy (156 documents, 12 folders):
#
#   Top-1: 82.7%  (129/156)
#   Top-3: 94.2%  (147/156)
#   Top-5: 97.4%  (152/156)
#
# Per-folder breakdown:
#   Invoices (23 docs)            Top-1: 91.3%   Top-3: 100.0%
#   Tax Returns (18 docs)         Top-1: 88.9%   Top-3: 100.0%
#   ...
#
# Most confused pairs:
#   Receipts ↔ Invoices (7 misclassifications)
```

Each document is temporarily removed from the model, classified against the rest, then restored. This gives an honest estimate of real-world accuracy.

### Test filename suggestions

Evaluate how well the filename suggestion pipeline works against your existing documents:

```bash
docc test-names                    # test all folders
docc test-names "Invoices/2024"    # test a specific folder
```

For each document, the tool uses its stored text and embedding to generate name suggestions (leave-one-out), then compares against the actual filename. Useful for tuning the LLM prompt, text limit, and similarity threshold.

### Interactive UI

Start a web interface to classify PDFs from your inbox folder:

```bash
docc ui                    # uses configured inbox, or cwd
docc ui ./unsorted         # or specify a folder
docc ui -p 8080            # custom port (default: 3141)
```

The UI shows a PDF preview on the left and classification controls on the right. Each PDF gets top-4 ranked folder suggestions with confidence scores. After classification, filename suggestions load asynchronously and populate a dropdown on the rename field — the first suggestion is auto-filled. Selecting a different folder triggers new name suggestions. If a near-duplicate of an already-filed document is detected (using content-only embeddings so identical PDFs with different filenames are correctly matched), a warning appears above the suggestions with options to compare side-by-side or delete the inbox copy. The file list for each suggested folder is interactive — clicking any file opens a side-by-side compare view against the inbox PDF. You can navigate freely between PDFs, go back to already-handled documents, and see where they were filed. All actions are logged to the terminal.

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `↑` / `↓` | Change selected suggestion (extends into folder search) |
| `1`-`4` | Pick suggestion and move immediately |
| `5` | Open folder search to specify a custom folder |
| `Enter` | Move to current selection |
| `←` / `→` | Navigate between PDFs |
| `s` | Skip to next PDF |
| `o` | Open selected folder in Finder |
| `Tab` | Toggle focus on rename field |
| `Esc` | Return from folder search / exit compare view |
| hold `i` | Show per-method detail (embedding similarity, ranks) |
| `c` | Compare with duplicate (when duplicate detected) |
| `d` | Delete from inbox (when duplicate detected or in compare view) |

The folder search supports multi-word queries (e.g., "Steuer 2024" matches folders containing both words). Files can be renamed before moving; `.pdf` is auto-appended if missing. Toast notifications confirm moves (green), skips (yellow), and deletes (red).

### Reset

```bash
docc reset
# Learned model cleared. Configuration (root, inbox) preserved.
```

Clears all learned data (documents, centroids, Bayes state) but keeps your configured paths. Run `learn` again to retrain.

> **Upgrading from an older version?** If your database was created before dual embeddings were added, duplicate detection and name similarity will fall back to enriched embeddings. Run `docc reset && docc learn` to populate the raw embeddings for best results.
