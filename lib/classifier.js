import { rankByCentroid } from './vectors.js';

// RRF constant — k=60 is standard for web search (1000s of results).
// With a small number of folders (10–50), a lower k amplifies rank differences.
const K = 5;

/**
 * Combine centroid-based and Bayes-based rankings via Reciprocal Rank Fusion.
 *
 * @param {Float64Array} embedding - Document embedding
 * @param {{ folder: string, embedding: Float64Array, docCount: number }[]} centroids
 * @param {{ folder: string, score: number }[]} bayesRanking - Pre-computed Bayes ranking
 * @param {number} [topN=5]
 * @returns {{ folder: string, score: number }[]} Top-N folders with normalized scores
 */
export function classifyDocument(embedding, centroids, bayesRanking, topN = 5) {
  // Rank by centroid similarity
  const centroidRanking = rankByCentroid(embedding, centroids);

  // Build rank maps (1-indexed)
  const centroidRank = {};
  centroidRanking.forEach((r, i) => { centroidRank[r.folder] = i + 1; });

  const bayesRank = {};
  bayesRanking.forEach((r, i) => { bayesRank[r.folder] = i + 1; });

  // Collect all folders
  const allFolders = new Set([
    ...centroidRanking.map(r => r.folder),
    ...bayesRanking.map(r => r.folder),
  ]);

  // Compute RRF scores
  const rrfScores = [];
  const fallbackRank = allFolders.size + 1;

  for (const folder of allFolders) {
    const cr = centroidRank[folder] || fallbackRank;
    const br = bayesRank[folder] || fallbackRank;
    const score = 1 / (K + cr) + 1 / (K + br);
    rrfScores.push({ folder, score });
  }

  rrfScores.sort((a, b) => b.score - a.score);

  // Normalize top-N scores to sum to 1
  const topResults = rrfScores.slice(0, topN);
  const totalScore = topResults.reduce((sum, r) => sum + r.score, 0);

  // Build score lookup maps for the top results
  const centroidScoreMap = {};
  centroidRanking.forEach(r => { centroidScoreMap[r.folder] = r.score; });

  return topResults.map(r => ({
    folder: r.folder,
    score: totalScore > 0 ? r.score / totalScore : 0,
    centroidRank: centroidRank[r.folder] || fallbackRank,
    centroidScore: centroidScoreMap[r.folder] ?? 0,
    bayesRank: bayesRank[r.folder] || fallbackRank,
  }));
}
