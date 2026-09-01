'use strict';

/**
 * Layer 2 — Brand Sentiment Engine.
 *
 * Lexicon-based sentiment scoring over the raw mentions collected in
 * Layer 1. Produces an overall brand health score (-100 to +100),
 * per-sample labels and the strongest themes, so the decision layer
 * can escalate negative spikes.
 */

const POSITIVE_WORDS = new Set([
  'love', 'loved', 'great', 'excellent', 'amazing', 'awesome', 'perfect',
  'happy', 'fast', 'quality', 'recommend', 'best', 'beautiful', 'smooth',
  'reliable', 'worth', 'fantastic', 'delighted', 'impressed', 'helpful',
],);

const NEGATIVE_WORDS = new Set([
  'hate', 'hated', 'bad', 'terrible', 'awful', 'slow', 'broken', 'cheap',
  'disappointed', 'disappointing', 'poor', 'worst', 'expensive', 'refund',
  'late', 'delayed', 'useless', 'frustrating', 'annoying', 'problem',
  'problems', 'issue', 'issues', 'scam', 'fake', 'damaged', 'missing',
],);

const NEGATIONS = new Set(['not', 'no', 'never', 'dont', 'don\'t', 'cant', 'can\'t', 'isnt', 'isn\'t',],);

function tokenize(text,) {
  return String(text,)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ',)
    .split(/\s+/,)
    .filter(Boolean,);
}

/** Score a single text from -100 to +100. */
function scoreText(text,) {
  const tokens = tokenize(text,);
  let positive = 0;
  let negative = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const negated = i > 0 && NEGATIONS.has(tokens[i - 1],);

    if (POSITIVE_WORDS.has(token,)) {
      if (negated) negative += 1;
      else positive += 1;
    } else if (NEGATIVE_WORDS.has(token,)) {
      if (negated) positive += 1;
      else negative += 1;
    }
  }

  const total = positive + negative;
  if (total === 0) return 0;
  return Math.round(((positive - negative) / total) * 100,);
}

function label(score,) {
  if (score >= 25) return 'positive';
  if (score <= -25) return 'negative';
  return 'neutral';
}

function createBrandSentimentEngine({ store, sentimentCollector, },) {
  return {
    /**
     * Analyze recent mentions for a store. Returns per-sample sentiment
     * plus an aggregated brand health score and top themes.
     */
    async analyze(store_id, limit = 200,) {
      const samples = await sentimentCollector.recent(store_id, limit,);

      const scored = samples.map((sample,) => {
        // Star ratings dominate when present; lexicon fills the gap.
        const ratingScore =
          typeof sample.rating === 'number' ? (sample.rating - 3) * 50 : null;
        const textScore = scoreText(sample.text,);
        const score = ratingScore !== null ? Math.round((ratingScore + textScore) / 2,) : textScore;

        return {
          sample_id: sample._id,
          source: sample.source,
          text: sample.text,
          rating: sample.rating,
          score,
          label: label(score,),
          collected_at: sample.collected_at,
        };
      },);

      const total = scored.length;
      const counts = { positive: 0, neutral: 0, negative: 0, };
      let sum = 0;

      for (const item of scored) {
        counts[item.label] += 1;
        sum += item.score;
      }

      const healthScore = total > 0 ? Math.round(sum / total,) : 0;

      // Theme extraction: most frequent opinion words.
      const themes = new Map();
      for (const item of scored) {
        for (const token of tokenize(item.text,)) {
          if (POSITIVE_WORDS.has(token,) || NEGATIVE_WORDS.has(token,)) {
            themes.set(token, (themes.get(token,) || 0) + 1,);
          }
        }
      }
      const topThemes = [...themes.entries(),]
        .sort((a, b,) => b[1] - a[1],)
        .slice(0, 5,)
        .map(([theme, mentions,],) => ({ theme, mentions, }),);

      return {
        store_id,
        analyzed_at: new Date().toISOString(),
        sample_count: total,
        health_score: healthScore,
        overall_label: label(healthScore,),
        counts,
        top_themes: topThemes,
        samples: scored,
      };
    },
  };
}

module.exports = { createBrandSentimentEngine, scoreText, label, };
