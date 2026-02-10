const STOPWORDS = new Set([
  // English
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
  'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
  'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see',
  'other', 'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over',
  'think', 'also', 'back', 'after', 'use', 'two', 'how', 'our', 'work',
  'first', 'well', 'way', 'even', 'new', 'want', 'because', 'any', 'these',
  'give', 'day', 'most', 'us', 'are', 'has', 'was', 'were', 'been', 'had',
  'did', 'does', 'is', 'am', 'may', 'shall', 'should', 'must', 'need',
  'page', 'date', 'name', 'number',
  // German
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem',
  'einen', 'eines', 'und', 'oder', 'aber', 'als', 'auch', 'auf', 'aus',
  'bei', 'bin', 'bis', 'bist', 'da', 'damit', 'dann', 'darf', 'darfst',
  'dazu', 'dein', 'deine', 'deinem', 'deinen', 'deiner', 'denn', 'doch',
  'dort', 'durch', 'eher', 'eigentlich', 'einige', 'einiger', 'einiges',
  'einmal', 'erst', 'etwas', 'euch', 'euer', 'eure', 'eurem', 'euren',
  'eurer', 'für', 'gegen', 'hab', 'habe', 'haben', 'hat', 'hatte', 'hätte',
  'hier', 'hin', 'hinter', 'ich', 'ihm', 'ihn', 'ihnen', 'ihr', 'ihre',
  'ihrem', 'ihren', 'ihrer', 'immer', 'ist', 'jede', 'jedem', 'jeden',
  'jeder', 'jedes', 'jedoch', 'jenem', 'jenen', 'jener', 'jenes', 'jetzt',
  'kann', 'kannst', 'kein', 'keine', 'keinem', 'keinen', 'keiner', 'konnte',
  'können', 'könnte', 'machen', 'man', 'manche', 'manchem', 'manchen',
  'mancher', 'manchmal', 'mehr', 'mein', 'meine', 'meinem', 'meinen',
  'meiner', 'mich', 'mir', 'mit', 'möchte', 'müssen', 'nach', 'nachdem',
  'nein', 'nicht', 'nichts', 'noch', 'nun', 'nur', 'ob', 'oben', 'ohne',
  'sehr', 'seid', 'sein', 'seine', 'seinem', 'seinen', 'seiner', 'seit',
  'sich', 'sie', 'sind', 'so', 'sogar', 'solch', 'solche', 'solchem',
  'solchen', 'solcher', 'soll', 'sollen', 'sollte', 'sollten', 'sondern',
  'sonst', 'über', 'um', 'und', 'uns', 'unser', 'unsere', 'unserem',
  'unseren', 'unter', 'viel', 'vom', 'von', 'vor', 'wann', 'warum', 'was',
  'weil', 'welch', 'welche', 'welchem', 'welchen', 'welcher', 'wenn', 'wer',
  'werde', 'werden', 'wie', 'wieder', 'will', 'wir', 'wird', 'wirst', 'wo',
  'wohl', 'wollen', 'worden', 'wurde', 'würde', 'während', 'zwar',
  'zwischen', 'zur', 'zum',
  // Common German document filler
  'bzw', 'ggf', 'etc', 'vgl', 'bitte', 'sowie', 'siehe', 'gilt',
  'gemäß', 'datum', 'seite', 'tel', 'fax', 'str', 'nr',
]);

/**
 * Tokenize text: lowercase, split on non-word characters (Unicode-aware),
 * filter stopwords and short tokens. Supports German (ä ö ü ß) and English.
 */
export function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

export class NaiveBayes {
  constructor() {
    // { [folder]: { [word]: count } }
    this.wordCounts = {};
    // { [folder]: count }
    this.docCounts = {};
    // { [folder]: count }
    this.totalWords = {};
    // Set<string>
    this.vocab = new Set();
  }

  train(tokens, folder) {
    if (!this.wordCounts[folder]) {
      this.wordCounts[folder] = {};
      this.docCounts[folder] = 0;
      this.totalWords[folder] = 0;
    }

    this.docCounts[folder]++;
    for (const token of tokens) {
      this.vocab.add(token);
      this.wordCounts[folder][token] = (this.wordCounts[folder][token] || 0) + 1;
      this.totalWords[folder]++;
    }
  }

  untrain(tokens, folder) {
    if (!this.wordCounts[folder]) return;

    this.docCounts[folder]--;
    for (const token of tokens) {
      if (this.wordCounts[folder][token]) {
        this.wordCounts[folder][token]--;
        this.totalWords[folder]--;
      }
    }
  }

  /**
   * Classify tokens, returning all folders with log-probability scores.
   * @returns {{ folder: string, score: number }[]} sorted descending by score
   */
  classify(tokens) {
    const folders = Object.keys(this.docCounts);
    const totalDocs = Object.values(this.docCounts).reduce((a, b) => a + b, 0);
    const vocabSize = this.vocab.size;
    const results = [];

    for (const folder of folders) {
      if (this.docCounts[folder] <= 0) continue;

      let logProb = Math.log(this.docCounts[folder] / totalDocs);
      const folderTotal = this.totalWords[folder];
      const folderWords = this.wordCounts[folder];

      for (const token of tokens) {
        const count = folderWords[token] || 0;
        logProb += Math.log((count + 1) / (folderTotal + vocabSize));
      }

      results.push({ folder, score: logProb });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  serialize() {
    return JSON.stringify({
      wordCounts: this.wordCounts,
      docCounts: this.docCounts,
      totalWords: this.totalWords,
      vocab: [...this.vocab],
    });
  }

  static deserialize(json) {
    const data = JSON.parse(json);
    const nb = new NaiveBayes();
    nb.wordCounts = data.wordCounts;
    nb.docCounts = data.docCounts;
    nb.totalWords = data.totalWords;
    nb.vocab = new Set(data.vocab);
    return nb;
  }
}
