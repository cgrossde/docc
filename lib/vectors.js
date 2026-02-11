/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Compute the centroid (element-wise mean) of a list of embeddings.
 */
export function computeCentroid(embeddings) {
  if (embeddings.length === 0) return null;
  const dim = embeddings[0].length;
  const centroid = new Float64Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= embeddings.length;
  }
  return centroid;
}

/**
 * Adjust a centroid by removing one embedding (for leave-one-out).
 * newCentroid = (centroid * n - embedding) / (n - 1)
 */
export function adjustCentroidRemove(centroid, embedding, n) {
  if (n <= 1) return null;
  const dim = centroid.length;
  const adjusted = new Float64Array(dim);
  for (let i = 0; i < dim; i++) {
    adjusted[i] = (centroid[i] * n - embedding[i]) / (n - 1);
  }
  return adjusted;
}

/**
 * Find near-duplicate documents by comparing an embedding against all stored docs.
 * @param {Float64Array} embedding - the query embedding
 * @param {Array} docs - all stored documents (from getAllDocs())
 * @param {number} threshold - minimum cosine similarity to consider a duplicate
 * @returns {{ path: string, folder: string, filename: string, similarity: number }[]}
 */
export function findDuplicates(embedding, docs, threshold = 0.985) {
  const matches = [];
  for (const doc of docs) {
    const docEmb = doc.embeddingRaw || doc.embedding;
    const sim = cosineSimilarity(embedding, docEmb);
    if (sim >= threshold) {
      const parts = doc.path.split('/');
      matches.push({
        path: doc.path,
        folder: doc.folder,
        filename: parts[parts.length - 1],
        similarity: sim,
      });
    }
  }
  matches.sort((a, b) => b.similarity - a.similarity);
  return matches.slice(0, 3);
}

/**
 * Rank folders by cosine similarity to the given embedding.
 * @returns {{ folder: string, score: number }[]} sorted descending
 */
export function rankByCentroid(embedding, centroids) {
  const results = centroids.map(c => ({
    folder: c.folder,
    score: cosineSimilarity(embedding, c.embedding),
  }));
  results.sort((a, b) => b.score - a.score);
  return results;
}
