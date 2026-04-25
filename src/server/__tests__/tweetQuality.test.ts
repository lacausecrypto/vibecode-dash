import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_HIGH_VALUE_HANDLES,
  MIN_QUALITY_SCORE,
  authorQualityScore,
  authorReachScore,
  contentQualityScore,
  curatedAuthorBoost,
  engagementVelocityScore,
  rankTweetsByQuality,
  tweetQualityScore,
} from '../lib/tweetQuality';
import type { XTweet, XTweetAuthor } from '../wrappers/xApi';

const NOW = 1_777_000_000; // fixed reference time so age-dependent scores are deterministic

function tweet(over: Partial<XTweet> & { ageMinutes?: number } = {}): XTweet {
  const ageMinutes = over.ageMinutes ?? 60;
  const created = new Date((NOW - ageMinutes * 60) * 1000).toISOString();
  return {
    id: 't1',
    text: 'A reasonable take on prompt engineering and how it changes when models can use tools.',
    author_id: 'u1',
    author_username: 'someone',
    created_at: over.created_at ?? created,
    public_metrics: over.public_metrics ?? {
      retweet_count: 0,
      reply_count: 0,
      like_count: 0,
      quote_count: 0,
    },
    ...over,
  };
}

const baseAuthor: XTweetAuthor = {
  followers_count: 1000,
  description: 'building stuff',
};

// ───────────────────── Engagement velocity ─────────────────────

describe('engagementVelocityScore', () => {
  test('returns 0 for a brand-new tweet with no engagement', () => {
    const t = tweet({ ageMinutes: 5 });
    expect(engagementVelocityScore(t, NOW)).toBe(0);
  });

  test('rises with engagement-per-hour, not absolute count', () => {
    // Tweet A: 1 hour old, 50 likes. Tweet B: 24 h old, 50 likes. A > B.
    const a = tweet({ ageMinutes: 60, public_metrics: stats({ like: 50 }) });
    const b = tweet({ ageMinutes: 60 * 24, public_metrics: stats({ like: 50 }) });
    expect(engagementVelocityScore(a, NOW)).toBeGreaterThan(engagementVelocityScore(b, NOW));
  });

  test('weights replies higher than likes (reply weight = 3)', () => {
    const likeOnly = tweet({ ageMinutes: 60, public_metrics: stats({ like: 30 }) });
    const replyOnly = tweet({ ageMinutes: 60, public_metrics: stats({ reply: 10 }) });
    // 30 likes vs 30 reply-equivalents (10 replies × weight 3) — same total weighted,
    // so scores must be equal. Catches a regression in the weight constants.
    expect(engagementVelocityScore(likeOnly, NOW)).toBeCloseTo(
      engagementVelocityScore(replyOnly, NOW),
      4,
    );
  });

  test('saturates near 1.0 at viral velocity', () => {
    // 1000 likes in 30 min ≈ 2000/h, well above the 200/h saturation point.
    const viral = tweet({
      ageMinutes: 30,
      public_metrics: stats({ like: 1000, retweet: 200 }),
    });
    expect(engagementVelocityScore(viral, NOW)).toBeGreaterThan(0.9);
  });
});

// ───────────────────── Author reach ─────────────────────

describe('authorReachScore', () => {
  test('returns 0 when author block is missing (privacy / API gap)', () => {
    expect(authorReachScore(undefined)).toBe(0);
  });

  test('returns 0 for accounts with 0 followers', () => {
    expect(authorReachScore({ ...baseAuthor, followers_count: 0 })).toBe(0);
  });

  test('rises monotonically with followers (log curve)', () => {
    const tiny = authorReachScore({ ...baseAuthor, followers_count: 100 });
    const small = authorReachScore({ ...baseAuthor, followers_count: 5_000 });
    const big = authorReachScore({ ...baseAuthor, followers_count: 500_000 });
    expect(tiny).toBeLessThan(small);
    expect(small).toBeLessThan(big);
    expect(big).toBeLessThanOrEqual(1);
  });

  test('saturates near 1.0 at million-follower scale', () => {
    expect(authorReachScore({ ...baseAuthor, followers_count: 5_000_000 })).toBeCloseTo(1, 1);
  });
});

// ───────────────────── Author quality (bio + verified_type) ─────────────────────

describe('authorQualityScore', () => {
  test('returns 0 when author missing', () => {
    expect(authorQualityScore(undefined)).toBe(0);
  });

  test('rewards CEO / founder bios strongly', () => {
    const ceoBio = authorQualityScore({
      ...baseAuthor,
      description: 'CEO at FooBar.io. Building agents.',
    });
    const founderBio = authorQualityScore({
      ...baseAuthor,
      description: 'co-founder of QuxLabs',
    });
    expect(ceoBio).toBeGreaterThan(0.4);
    expect(founderBio).toBeGreaterThan(0.4);
  });

  test('rewards researcher / scientist bios moderately', () => {
    const scoreResearcher = authorQualityScore({
      ...baseAuthor,
      description: 'ML researcher curious about systems',
    });
    const scoreNoise = authorQualityScore({
      ...baseAuthor,
      description: 'shitposting one tweet at a time',
    });
    expect(scoreResearcher).toBeGreaterThan(scoreNoise);
    expect(scoreResearcher).toBeGreaterThan(0.2);
  });

  test('treats business / government verified_type as strong, paid Blue as zero', () => {
    const business = authorQualityScore({
      ...baseAuthor,
      verified: true,
      verified_type: 'business',
    });
    const blue = authorQualityScore({
      ...baseAuthor,
      verified: true,
      verified_type: 'blue',
    });
    expect(business).toBeGreaterThan(0.3);
    expect(blue).toBe(0);
  });

  test('legacy `verified: true` without verified_type gets a small bump', () => {
    const legacy = authorQualityScore({ ...baseAuthor, verified: true });
    expect(legacy).toBeGreaterThan(0);
    expect(legacy).toBeLessThan(0.3); // not as strong as business/gov verification
  });

  test('caps the composite at 1.0', () => {
    const stacked = authorQualityScore({
      followers_count: 500_000,
      verified: true,
      verified_type: 'business',
      description: 'Co-founder at Anthropic. Researcher and engineer.',
    });
    expect(stacked).toBeLessThanOrEqual(1);
  });
});

// ───────────────────── Content quality ─────────────────────

describe('contentQualityScore', () => {
  test('returns near-zero for empty content', () => {
    expect(contentQualityScore('')).toBe(0);
  });

  test('returns near-zero for a link-only tweet', () => {
    expect(contentQualityScore('https://example.com/blog/foo')).toBeLessThanOrEqual(0.05);
  });

  test('rewards substantive multi-sentence text', () => {
    const long =
      'Tools for LLMs are not just function calls. They are a way to bound context. ' +
      'When you let the model decide what to read, you also let it decide what to ignore.';
    expect(contentQualityScore(long)).toBeGreaterThan(0.7);
  });

  test('penalizes ALL-CAPS shouting', () => {
    const caps = 'WHY DOES NOBODY TALK ABOUT THIS GIANT BUG IN MOST AGENT FRAMEWORKS???';
    const normal = 'why does nobody talk about this giant bug in most agent frameworks?';
    expect(contentQualityScore(caps)).toBeLessThan(contentQualityScore(normal));
  });

  test('penalizes spammy multi-mention shape', () => {
    const spammy = '@alice @bob @charlie @dave @eve @frank thoughts? would love your take';
    expect(contentQualityScore(spammy)).toBeLessThan(0.4);
  });
});

// ───────────────────── Curated boost ─────────────────────

describe('curatedAuthorBoost', () => {
  test('returns 0.15 for a default high-value handle', () => {
    expect(curatedAuthorBoost('sama')).toBe(0.15);
    expect(curatedAuthorBoost('Karpathy')).toBe(0.15); // case-insensitive
  });

  test('returns 0 for unknown handles', () => {
    expect(curatedAuthorBoost('random_user_123')).toBe(0);
  });

  test('respects a custom override list', () => {
    const custom = new Set(['my_niche_handle']);
    expect(curatedAuthorBoost('my_niche_handle', custom)).toBe(0.15);
    expect(curatedAuthorBoost('sama', custom)).toBe(0); // not in custom list
  });

  test('returns 0 when username is missing', () => {
    expect(curatedAuthorBoost(undefined)).toBe(0);
  });
});

// ───────────────────── Composite + ranking ─────────────────────

describe('tweetQualityScore', () => {
  test('curated handle dominates a low-engagement tweet', () => {
    // @karpathy posting something with 0 likes (tweet just out) still scores
    // above the threshold because the curated boost + likely high reach.
    const samaLowEngage = tweet({
      author_id: 'u_sama',
      author_username: 'karpathy',
      ageMinutes: 5,
      public_metrics: stats({ like: 1 }),
      author: { followers_count: 800_000, description: 'researcher' },
    });
    const score = tweetQualityScore(samaLowEngage, NOW);
    expect(score.curated_boost).toBe(0.15);
    expect(score.total).toBeGreaterThan(MIN_QUALITY_SCORE);
  });

  test('high-engagement tweet from a no-name still passes', () => {
    // Reach gets through purely on velocity — the gate must allow this so
    // we don't miss a viral take from an account we haven't curated.
    const viral = tweet({
      author_id: 'u_unknown',
      author_username: 'rando42',
      ageMinutes: 30,
      public_metrics: stats({ like: 800, retweet: 150, reply: 80 }),
      author: { followers_count: 500, description: '' },
    });
    expect(tweetQualityScore(viral, NOW).total).toBeGreaterThan(MIN_QUALITY_SCORE);
  });

  test('zero-everything throwaway is dropped (below threshold)', () => {
    const trash = tweet({
      ageMinutes: 5,
      public_metrics: stats({ like: 0 }),
      author: { followers_count: 5, description: '' },
      text: 'lol',
    });
    expect(tweetQualityScore(trash, NOW).total).toBeLessThan(MIN_QUALITY_SCORE);
  });

  test('breakdown components are all in [0, 1]', () => {
    const t = tweet({
      author: { followers_count: 50_000, verified: true, verified_type: 'business' },
      public_metrics: stats({ like: 200, reply: 10, retweet: 30 }),
      ageMinutes: 60,
    });
    const b = tweetQualityScore(t, NOW);
    for (const v of [b.velocity, b.reach, b.author_quality, b.content, b.curated_boost]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(b.total).toBeLessThanOrEqual(1);
    expect(b.total).toBeGreaterThanOrEqual(0);
  });
});

describe('rankTweetsByQuality', () => {
  test('returns tweets sorted by score, threshold-filtered, capped at maxResults', () => {
    const tweets: XTweet[] = [
      tweet({
        id: 't_high',
        author_username: 'sama',
        ageMinutes: 60,
        public_metrics: stats({ like: 200 }),
        author: { followers_count: 1_000_000, description: 'CEO' },
      }),
      tweet({
        id: 't_mid',
        author_username: 'noone',
        ageMinutes: 60,
        public_metrics: stats({ like: 30 }),
        author: { followers_count: 5_000, description: 'researcher' },
      }),
      tweet({
        id: 't_low',
        author_username: 'spammer',
        ageMinutes: 60,
        public_metrics: stats({ like: 0 }),
        author: { followers_count: 1, description: '' },
        text: 'gm',
      }),
    ];
    const ranked = rankTweetsByQuality(tweets, { nowSec: NOW, maxResults: 5 });
    expect(ranked.length).toBe(2); // low one filtered
    expect(ranked[0].tweet.id).toBe('t_high');
    expect(ranked[0].quality.total).toBeGreaterThan(ranked[1].quality.total);
  });

  test('respects the maxResults cap even when all tweets pass threshold', () => {
    const tweets = Array.from({ length: 10 }, (_, i) =>
      tweet({
        id: `t${i}`,
        author_username: 'sama', // forces high score for all
        public_metrics: stats({ like: 100, retweet: 20 }),
        author: { followers_count: 100_000, description: 'CEO' },
      }),
    );
    expect(rankTweetsByQuality(tweets, { nowSec: NOW, maxResults: 3 }).length).toBe(3);
  });

  test('honours custom highValueHandles override', () => {
    const tweets: XTweet[] = [
      tweet({
        id: 't_default_curated',
        author_username: 'sama',
        public_metrics: stats({ like: 5 }),
        author: { followers_count: 1000, description: '' },
      }),
      tweet({
        id: 't_custom_curated',
        author_username: 'my_niche',
        public_metrics: stats({ like: 5 }),
        author: { followers_count: 1000, description: '' },
      }),
    ];
    const customs = new Set(['my_niche']);
    // minScore: 0 — we're testing the curated_boost flag in the breakdown,
    // not the gate behaviour. With the default 0.40 threshold both these
    // synthetic tweets get filtered out (low engagement + no bio), which
    // would mask the boost-application logic.
    const ranked = rankTweetsByQuality(tweets, {
      nowSec: NOW,
      minScore: 0,
      highValueHandles: customs,
    });
    // With the custom set, sama is no longer curated; my_niche IS.
    const curatedIds = ranked.filter((r) => r.quality.curated_boost > 0).map((r) => r.tweet.id);
    expect(curatedIds).toEqual(['t_custom_curated']);
  });
});

// ───────────────────── DEFAULT_HIGH_VALUE_HANDLES sanity ─────────────────────

describe('DEFAULT_HIGH_VALUE_HANDLES', () => {
  test('is short enough to remain meaningful', () => {
    // Bigger than ~80 entries means the boost has lost its signal.
    expect(DEFAULT_HIGH_VALUE_HANDLES.size).toBeLessThan(80);
  });

  test('all handles are lowercased + no `@`', () => {
    for (const h of DEFAULT_HIGH_VALUE_HANDLES) {
      expect(h).toBe(h.toLowerCase());
      expect(h.startsWith('@')).toBe(false);
    }
  });
});

// ───────────────────── helpers ─────────────────────

function stats(over: {
  like?: number;
  retweet?: number;
  reply?: number;
  quote?: number;
}): XTweet['public_metrics'] {
  return {
    like_count: over.like ?? 0,
    retweet_count: over.retweet ?? 0,
    reply_count: over.reply ?? 0,
    quote_count: over.quote ?? 0,
  };
}
