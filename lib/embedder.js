const OLLAMA_URL = 'http://localhost:11434/api/embed';
const MODEL = 'nomic-embed-text';

// nomic-embed-text has an 8192-token context window.
// Start conservative, retry shorter on context-length errors.
const TRUNCATION_LIMITS = [8000, 4000, 2000];

/**
 * Embed text via Ollama REST API.
 * @param {string} text - Text to embed
 * @returns {Promise<Float64Array>} 768-dimensional embedding vector
 */
export async function embed(text) {
  for (const limit of TRUNCATION_LIMITS) {
    const truncated = text.slice(0, limit);

    let res;
    try {
      res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input: truncated }),
      });
    } catch (err) {
      throw new Error(
        `Cannot connect to Ollama at ${OLLAMA_URL}. Is Ollama running? (ollama serve)\n${err.message}`
      );
    }

    if (res.ok) {
      const json = await res.json();
      return new Float64Array(json.embeddings[0]);
    }

    const body = await res.text();
    if (res.status === 400 && body.includes('context length')) {
      continue; // retry with shorter text
    }

    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }

  throw new Error('Text exceeds model context length even after truncation');
}
