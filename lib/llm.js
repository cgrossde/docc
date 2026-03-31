import { OLLAMA_BASE, GENERATE_MODEL } from './ollama.js';

const OLLAMA_URL = `${OLLAMA_BASE}/api/generate`;

/**
 * Generate text via Ollama REST API.
 * @param {string} prompt - User prompt
 * @param {string} [system] - System prompt
 * @param {{ temperature?: number, num_predict?: number }} [options]
 * @returns {Promise<string>} Generated text
 */
export async function generate(prompt, system, options = {}) {
  const body = {
    model: GENERATE_MODEL,
    prompt,
    stream: false,
    think: false,
    options: {
      temperature: options.temperature ?? 0.7,
      num_predict: options.num_predict ?? 50,
    },
  };
  if (system) body.system = system;

  let res;
  try {
    res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error('LLM generation timed out after 15s');
    }
    throw new Error(
      `Cannot connect to Ollama at ${OLLAMA_URL}. Is Ollama running? (ollama serve)\n${err.message}`
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama generate failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  return json.response || '';
}
