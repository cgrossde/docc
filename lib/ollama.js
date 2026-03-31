import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const OLLAMA_BASE = 'http://localhost:11434';
export const EMBED_MODEL = 'qwen3-embedding:0.6b';
export const GENERATE_MODEL = 'qwen3:1.7b';

export async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim().toLowerCase().startsWith('y'));
    });
  });
}

export function run(cmd, args, { label } = {}) {
  return new Promise((res, reject) => {
    if (label) console.log(label);
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) res();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function waitForOllama(maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await checkOllama()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Ensure Ollama is installed and the server is running.
 *
 * - Not installed + brew available → prompt user to install via Homebrew
 * - Not installed, no brew → print error with ollama.com link and exit
 * - Not running → spawn `ollama serve`, wait up to 15 s
 *
 * Returns the spawned ChildProcess if we started the server, or null if it
 * was already running (so callers know whether to stop it on exit).
 *
 * @returns {Promise<import('node:child_process').ChildProcess | null>}
 */
export async function ensureOllama() {
  if (!commandExists('ollama')) {
    if (!commandExists('brew')) {
      console.error('Error: Ollama is not installed. Install it from https://ollama.com');
      process.exit(1);
    }
    const yes = await confirm('Ollama is not installed. Install via Homebrew? [y/N] ');
    if (!yes) {
      console.log('Aborted.');
      process.exit(1);
    }
    await run('brew', ['install', 'ollama'], { label: 'Installing Ollama...' });
    console.log('Ollama installed.');
  }

  if (await checkOllama()) {
    console.log(`Ollama already running at ${OLLAMA_BASE}.`);
    return null;
  }

  console.log('Starting Ollama...');
  const child = spawn('ollama', ['serve'], { stdio: 'ignore', detached: false });

  if (!await waitForOllama()) {
    console.error('Error: Ollama did not start in time. Try running `ollama serve` manually.');
    process.exit(1);
  }

  console.log(`Ollama started at ${OLLAMA_BASE}`);
  return child;
}

/**
 * Pull EMBED_MODEL and GENERATE_MODEL if not already present.
 * Checks /api/tags first to avoid unnecessary network calls.
 */
export async function ensureModels() {
  const res = await fetch('http://localhost:11434/api/tags');
  const { models } = await res.json();
  const present = new Set(models.map(m => m.name));

  for (const model of [EMBED_MODEL, GENERATE_MODEL]) {
    if (!present.has(model)) {
      await run('ollama', ['pull', model], { label: `Pulling ${model}...` });
    }
  }
}

/**
 * Register signal/exit handlers to stop Ollama when the process exits.
 * No-op if child is null (Ollama was already running — we don't own it).
 *
 * @param {import('node:child_process').ChildProcess | null} child
 */
export function registerOllamaCleanup(child) {
  if (!child) return;
  const stop = () => { try { console.log('Stopping Ollama.'); child.kill('SIGTERM'); } catch {} };
  process.once('exit', stop);
  process.once('SIGINT', () => { stop(); process.exit(130); });
  process.once('SIGTERM', () => { stop(); process.exit(143); });
}
