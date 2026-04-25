import type { Hono } from 'hono';
import { z } from 'zod';
import { loadSettings, saveSettings } from '../config';
import { getDb } from '../db';
import { pollPresenceEngagement } from '../jobs/presenceEngagement';
import { enqueueScan, getJob, listRecentJobs } from '../jobs/presenceJobs';
import { runPresenceScan } from '../jobs/presenceScan';
import { getMergedAgentModels } from '../lib/agentModels';
import {
  PRESENCE_DRAFT_FORMATS,
  PRESENCE_DRAFT_STATUSES,
  PRESENCE_ENGAGEMENT_TAGS,
  PRESENCE_PLATFORMS,
  PRESENCE_SOURCE_KINDS,
  type PresencePlatform,
  bulkDeleteDrafts,
  bulkTransitionDrafts,
  createDraft,
  createSource,
  deleteConnection,
  deleteDraft,
  deleteSource,
  expireStaleDrafts,
  getDraft,
  getFeedSummary,
  getOverviewStats,
  listConnections,
  listDraftEngagement,
  listDrafts,
  listEvents,
  listSources,
  recordCost,
  recordEngagement,
  recordEvent,
  transitionDraft,
  updateDraftBody,
  updateSource,
  upsertConnection,
} from '../lib/presence';
import {
  classifyImageNeed,
  generateDraft,
  scoreCandidate,
  translateDraft,
} from '../lib/presenceDrafter';
import { refreshPersonaAntiPatterns } from '../lib/presencePersona';
import { discoverRedditRelated, discoverXCoCited } from '../lib/sourceDiscovery';
import { refreshAllSourceHealth } from '../lib/sourceHealth';
import { dismissPruneSuggestion, getPruneSuggestions } from '../lib/sourcePrune';
import {
  setSourceValidationStatus,
  validateAllSources,
  validateSourceIdentifier,
} from '../lib/sourceValidation';
import {
  deleteOpenrouterKey,
  estimateImageCost,
  openrouterIsConfigured,
  orImage,
  saveOpenrouterKey,
} from '../wrappers/openrouter';
import { listSubredditHot, listSubredditNew, listUserSubmitted } from '../wrappers/redditApi';
import {
  deleteRedditCreds,
  redditIsConnected,
  redditWhoami,
  saveRedditCreds,
} from '../wrappers/redditApi';
import { buildTopicQuery, getListTimeline, getUserTimeline, searchRecent } from '../wrappers/xApi';
import { deleteXCreds, saveXCreds, xIsConnected, xWhoami } from '../wrappers/xApi';

const IMAGE_MODEL_BY_KIND: Record<'diagram' | 'illustration' | 'photo', string | null> = {
  // Diagrams render client-side from mermaid code; no image gen needed.
  diagram: null,
  // Pro tier of Gemini. ~$0.04/image. Significantly better than 2.5-flash on
  // composition, lighting, and prompt adherence — worth the bump for social
  // posts where image quality matters more than the few-cents savings.
  illustration: 'google/gemini-3-pro-image-preview',
  // Photoreal default. gpt-5.4-image-2 is OpenAI's latest with best photoreal.
  photo: 'openai/gpt-5.4-image-2',
};

// ────────────────────── Schemas ──────────────────────

const PlatformSchema = z.enum(PRESENCE_PLATFORMS);
const SourceKindSchema = z.enum(PRESENCE_SOURCE_KINDS);
const DraftStatusSchema = z.enum(PRESENCE_DRAFT_STATUSES);
const DraftFormatSchema = z.enum(PRESENCE_DRAFT_FORMATS);
const EngagementTagSchema = z.enum(PRESENCE_ENGAGEMENT_TAGS);

const SourceCreateSchema = z.object({
  platform: PlatformSchema,
  kind: SourceKindSchema,
  identifier: z.string().min(1).max(200),
  label: z.string().max(200).optional().nullable(),
  weight: z.number().min(0).max(5).optional(),
  freshness_ttl_minutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 14)
    .optional(),
});

const SourceUpdateSchema = z.object({
  label: z.string().max(200).optional().nullable(),
  weight: z.number().min(0).max(5).optional(),
  freshness_ttl_minutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 14)
    .optional(),
  active: z.boolean().optional(),
});

const DraftCreateSchema = z.object({
  platform: PlatformSchema,
  source_id: z.string().uuid().nullable().optional(),
  external_thread_id: z.string().max(200).nullable().optional(),
  external_thread_url: z.string().url().max(500).nullable().optional(),
  thread_snapshot: z.unknown(),
  format: DraftFormatSchema,
  relevance_score: z.number().min(0).max(1),
  freshness_expires_at: z.number().int().positive(),
  draft_body: z.string().min(1).max(20_000),
  draft_rationale: z.string().max(2000).optional().nullable(),
  vault_citations: z.array(z.string()).max(20).optional(),
  radar_insight_ids: z.array(z.string()).max(20).optional(),
  image_plan: z.unknown().optional(),
});

const DraftUpdateSchema = z.object({
  draft_body: z.string().min(1).max(20_000).optional(),
  image_plan: z.unknown().optional(),
});

const DraftTransitionSchema = z.object({
  status: DraftStatusSchema,
  posted_external_id: z.string().max(200).optional(),
  posted_external_url: z.string().url().max(500).optional(),
});

const BulkTransitionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  status: DraftStatusSchema,
});

const EngagementRecordSchema = z.object({
  snapshot_tag: EngagementTagSchema,
  likes: z.number().int().min(0).nullable().optional(),
  replies: z.number().int().min(0).nullable().optional(),
  reposts: z.number().int().min(0).nullable().optional(),
  impressions: z.number().int().min(0).nullable().optional(),
  ratio: z.number().min(0).max(1).nullable().optional(),
  raw: z.unknown().optional(),
});

const ConnectionUpsertSchema = z.object({
  platform: PlatformSchema,
  account_handle: z.string().max(100).optional().nullable(),
  keychain_ref: z.string().max(200).optional().nullable(),
  scopes: z.array(z.string()).max(30).optional(),
});

const RedditConnectSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(200),
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

const XConnectSchema = z.object({
  bearer: z.string().min(10).max(4000),
  username: z.string().min(1).max(100).optional(),
});

const OpenrouterConnectSchema = z.object({
  apiKey: z.string().min(10).max(400),
});

const ScanNowSchema = z.object({
  platform: PlatformSchema.optional(),
  source_id: z.string().uuid().optional(),
});

const ImageGenSchema = z.object({
  kind: z.enum(['diagram', 'illustration', 'photo']).optional(),
  prompt: z.string().min(5).max(2000).optional(),
});

const TranslateSchema = z.object({
  target_lang: z.enum(['fr', 'en', 'es']),
});

const DrafterConfigSchema = z.object({
  drafterProvider: z.enum(['claude', 'codex']),
  scorerModel: z.string().min(1).max(100),
  drafterModel: z.string().min(1).max(100),
  xReadCostUsd: z.number().min(0).max(1).optional(),
});

/**
 * Scheduler config payload. Toggle takes effect on next scheduler tick
 * without restart (jobs gate on the flag at run time). Cadence changes
 * require a server restart since setInterval is set at boot — we surface
 * that hint in the UI rather than implement live cadence rebinding.
 */
const SchedulerConfigSchema = z.object({
  autoScanEnabled: z.boolean(),
  scanIntervalMinutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24)
    .optional(),
  engagementPollIntervalMinutes: z
    .number()
    .int()
    .min(15)
    .max(60 * 24)
    .optional(),
  dailyBudgetUsd: z.number().min(0).max(100).optional(),
  engagementPollEnabled: z.boolean().optional(),
});

// ────────────────────── Register ──────────────────────

export function registerPresenceRoutes(app: Hono): void {
  // ─── Sources ────────────────────────────────────────
  app.get('/api/presence/sources', (c) => {
    const platform = c.req.query('platform') as z.infer<typeof PlatformSchema> | undefined;
    const activeOnly = c.req.query('active') === 'true';
    return c.json(
      listSources(getDb(), {
        platform: platform && PRESENCE_PLATFORMS.includes(platform) ? platform : undefined,
        activeOnly,
      }),
    );
  });

  app.post('/api/presence/sources', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = SourceCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    // Pre-create validation hook. We refuse confirmed-dead identifiers so the
    // user gets immediate feedback ("r/foo doesn't exist", "@bar suspended")
    // instead of a silent insert that would later fail at scan time. `error`
    // and `partial` outcomes still go through (network blip / x_topic with
    // mixed handles) — the user should review, not be blocked.
    try {
      const validation = await validateSourceIdentifier({
        platform: parsed.data.platform,
        kind: parsed.data.kind,
        identifier: parsed.data.identifier,
      });
      if (
        validation.status === 'not_found' ||
        validation.status === 'banned' ||
        validation.status === 'invalid_format'
      ) {
        return c.json(
          {
            error: 'source_not_reachable',
            details: `Platform reports the identifier as ${validation.status}: ${parsed.data.identifier}`,
            validation,
          },
          422,
        );
      }
      const row = createSource(getDb(), parsed.data);
      // Persist the just-computed validation state immediately so the source
      // doesn't briefly show as "never validated" after creation.
      setSourceValidationStatus(getDb(), row.id, validation);
      return c.json({ ...row, validation_status: validation.status, validation }, 201);
    } catch (error) {
      const msg = String(error);
      const isDup = /UNIQUE constraint failed/i.test(msg);
      return c.json(
        { error: isDup ? 'duplicate_source' : 'db_error', details: msg },
        isDup ? 409 : 500,
      );
    }
  });

  /**
   * Walk every source and re-validate it. Useful after a long pause, after
   * Reddit/X policy changes that nuke a handle, or just for confidence
   * before activating a fresh batch. Sources confirmed dead get
   * auto-deactivated (active = 0); the response details every per-source
   * outcome for the UI.
   *
   * Cost: zero (Reddit /about.json + X syndication CDN). Time: ~5s per
   * 25 Reddit subs (200 ms throttle), ~1s for all X (batched).
   */
  /**
   * Re-classify every source's ROI band (Pack B). Pure SQL + TS, no
   * external calls, returns the per-source breakdown so the UI can show
   * before/after deltas. Also runs daily via scheduler; this endpoint
   * exists so the user can force a refresh after a heavy posting session.
   */
  /**
   * Pack D — Graph-based source discovery. Returns suggestions of new
   * sources to add, derived from existing sources' graph proximity.
   *
   *   ?platform=reddit → walks active subs' /about.json + /widgets.json
   *     for r/foo mentions, ranks by cross-source frequency.
   *   ?platform=x → scans recent high-score drafts (last 30 days, score
   *     >= 0.5) for @handle mentions not already covered by an active X
   *     source. Free, runs entirely on local DB data.
   *
   * Both modes filter out identifiers already in our `presence_sources`
   * table so we never re-suggest what's already tracked.
   */
  app.get('/api/presence/sources/discover-related', async (c) => {
    const url = new URL(c.req.url);
    const platform = url.searchParams.get('platform');
    if (platform !== 'reddit' && platform !== 'x') {
      return c.json(
        { error: 'invalid_platform', details: 'platform query param must be reddit or x' },
        400,
      );
    }
    try {
      const result =
        platform === 'reddit' ? await discoverRedditRelated(getDb()) : discoverXCoCited(getDb());
      return c.json(result);
    } catch (error) {
      return c.json({ error: 'discovery_failed', details: String(error) }, 502);
    }
  });

  /**
   * Pack C — Prune suggestions. Returns the list of currently-active
   * sources flagged dead/stale/noisy with human-readable rationale. The
   * user clicks Deactivate (existing PATCH active=0) or Keep (POST
   * /sources/:id/keep below) per card.
   */
  app.get('/api/presence/sources/prune-suggestions', (c) => {
    try {
      const result = getPruneSuggestions(getDb());
      return c.json(result);
    } catch (error) {
      return c.json({ error: 'prune_suggestions_failed', details: String(error) }, 502);
    }
  });

  /**
   * "Keep, recompute next week" — sets the cooldown timestamp so the
   * source is hidden from prune-suggestions for 7 days.
   */
  app.post('/api/presence/sources/:id/keep', (c) => {
    const id = c.req.param('id');
    const ok = dismissPruneSuggestion(getDb(), id);
    if (!ok) return c.json({ error: 'source_not_found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/presence/sources/refresh-health', (c) => {
    try {
      const result = refreshAllSourceHealth(getDb());
      return c.json(result);
    } catch (error) {
      return c.json({ error: 'health_refresh_failed', details: String(error) }, 502);
    }
  });

  app.post('/api/presence/sources/validate-all', async (c) => {
    const url = new URL(c.req.url);
    const activeOnly = url.searchParams.get('active_only') === 'true';
    try {
      const result = await validateAllSources(getDb(), { activeOnly });
      return c.json(result);
    } catch (error) {
      return c.json({ error: 'validate_all_failed', details: String(error) }, 502);
    }
  });

  app.patch('/api/presence/sources/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = SourceUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    const row = updateSource(getDb(), c.req.param('id'), parsed.data);
    if (!row) return c.json({ error: 'source_not_found' }, 404);
    return c.json(row);
  });

  // Source dry-run preview — fetch a few candidates from a hypothetical
  // source, score and draft them, but DO NOT persist. Lets the user check
  // quality before committing the source to the catalogue. No `created_at`,
  // no draft rows, no event log entries. Cost ledger DOES record the
  // scoring/drafting calls (they happened, they're billed/sub-counted).
  app.post('/api/presence/sources/preview', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = SourceCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    const settings = await loadSettings();
    const db = getDb();
    const SAMPLE_LIMIT = 4; // bound the cost — preview is just sanity check
    const samples: Array<{
      score: number;
      rationale: string;
      draft_body: string;
      format: string;
      source_url?: string | null;
    }> = [];
    try {
      // Reddit path — works in public mode, no setup required.
      if (parsed.data.platform === 'reddit') {
        const id = parsed.data.identifier.replace(/^\/?(r|u|user)\//, '');
        let posts: {
          title: string;
          selftext: string;
          author: string;
          score: number;
          permalink: string;
        }[] = [];
        if (parsed.data.kind === 'subreddit') {
          const hot = await listSubredditHot(id, { limit: 10 });
          posts = hot.posts;
        } else if (parsed.data.kind === 'reddit_user') {
          posts = await listUserSubmitted(id, { limit: 10 });
        } else {
          // Force the new-listing fallback for completeness.
          const fresh = await listSubredditNew(id, { limit: 10 });
          posts = fresh.posts;
        }
        for (const p of posts.slice(0, SAMPLE_LIMIT)) {
          const candidate = {
            platform: 'reddit' as const,
            thread: {
              author: p.author,
              title: p.title,
              body: p.selftext,
              score: p.score,
              url: `https://reddit.com${p.permalink}`,
            },
            preferredFormat: 'comment' as const,
          };
          const scored = await scoreCandidate(db, settings, candidate);
          if (scored.score < 0.5) {
            samples.push({
              score: scored.score,
              rationale: scored.rationale,
              draft_body: '',
              format: 'comment',
              source_url: candidate.thread.url,
            });
            continue;
          }
          const draft = await generateDraft(db, settings, candidate, scored.score);
          samples.push({
            score: draft.score,
            rationale: draft.rationale,
            draft_body: draft.draft_body,
            format: draft.format,
            source_url: candidate.thread.url,
          });
        }
      }
      // X path — needs the bearer; we surface an actionable error if absent.
      else if (parsed.data.platform === 'x') {
        const id = parsed.data.identifier.trim();
        let tweets: Awaited<ReturnType<typeof getListTimeline>> = [];
        try {
          if (parsed.data.kind === 'x_list') tweets = await getListTimeline(id, { maxResults: 10 });
          else if (parsed.data.kind === 'x_user')
            tweets = await getUserTimeline(id, { maxResults: 10 });
          else if (parsed.data.kind === 'x_topic')
            tweets = await searchRecent(buildTopicQuery(id, { lang: 'en' }), { maxResults: 10 });
        } catch (error) {
          return c.json({ error: 'x_fetch_failed', details: String(error).slice(0, 300) }, 502);
        }
        for (const t of tweets.slice(0, SAMPLE_LIMIT)) {
          const candidate = {
            platform: 'x' as const,
            thread: {
              author: t.author_username,
              body: t.text,
              score: t.public_metrics.like_count,
              url: `https://x.com/${t.author_username ?? 'i'}/status/${t.id}`,
            },
            preferredFormat: 'reply' as const,
          };
          const scored = await scoreCandidate(db, settings, candidate);
          if (scored.score < 0.5) {
            samples.push({
              score: scored.score,
              rationale: scored.rationale,
              draft_body: '',
              format: 'reply',
              source_url: candidate.thread.url,
            });
            continue;
          }
          const draft = await generateDraft(db, settings, candidate, scored.score);
          samples.push({
            score: draft.score,
            rationale: draft.rationale,
            draft_body: draft.draft_body,
            format: draft.format,
            source_url: candidate.thread.url,
          });
        }
      }
      return c.json({ samples, sample_limit: SAMPLE_LIMIT });
    } catch (error) {
      return c.json({ error: 'preview_failed', details: String(error).slice(0, 300) }, 500);
    }
  });

  // ─── (Direct posting removed) ──────────────────
  // The previous /drafts/:id/post + /connect/x-oauth1 routes have been
  // dropped in favour of an "assist mode" flow client-side: the UI copies
  // the body to the clipboard and opens the original Reddit thread or an
  // X intent URL in a new tab, then prompts for the resulting URL on
  // return. Engagement polling still works without write creds (Reddit via
  // public permalink.json, X via syndication CDN).
  //
  // The Reddit OAuth connect (/connect/reddit) stays because it's used for
  // RICHER reads (rate limits, private fields). It no longer needs to grant
  // submit/edit scopes — read-only is enough.

  // Manually trigger the persona anti-patterns refresh (also runs weekly
  // via scheduler). Useful right after a batch edit session.
  // Manual engagement poller trigger. Defaults to `force: true` because a
  // manual click is explicit user intent: the user wants engagement data
  // NOW, even if no auto-snapshot window is open. With force, drafts that
  // are between windows get captured under the `manual` tag (excluded from
  // the time-series aggregate to avoid skewing t+1h/t+24h/t+7d averages).
  // Drafts that ARE in a window still get their canonical tag.
  //
  // The response includes `pending` (drafts still waiting on their first
  // window when force=false) so the UI can surface ETAs instead of just
  // "polled: 0".
  app.post('/api/presence/engagement-poll-now', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const force = body?.force !== false; // default true for manual button
    try {
      const result = await pollPresenceEngagement(getDb(), { force });
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json({ error: 'engagement_poll_failed', details: String(error) }, 502);
    }
  });

  app.post('/api/presence/persona/refresh', async (c) => {
    try {
      const settings = await loadSettings();
      const out = await refreshPersonaAntiPatterns(getDb(), settings);
      return c.json(out, out.ok ? 200 : 502);
    } catch (error) {
      return c.json({ error: 'persona_refresh_failed', details: String(error) }, 500);
    }
  });

  app.delete('/api/presence/sources/:id', (c) => {
    const ok = deleteSource(getDb(), c.req.param('id'));
    if (!ok) return c.json({ error: 'source_not_found' }, 404);
    return c.json({ ok: true });
  });

  // ─── Drafts ─────────────────────────────────────────
  app.get('/api/presence/drafts', (c) => {
    const platform = c.req.query('platform') as z.infer<typeof PlatformSchema> | undefined;
    const statusParam = c.req.query('status');
    const statuses = statusParam
      ? (statusParam
          .split(',')
          .filter((s) => (PRESENCE_DRAFT_STATUSES as readonly string[]).includes(s)) as z.infer<
          typeof DraftStatusSchema
        >[])
      : undefined;
    const limit = Number.parseInt(c.req.query('limit') || '100', 10);
    return c.json(
      listDrafts(getDb(), {
        platform: platform && PRESENCE_PLATFORMS.includes(platform) ? platform : undefined,
        statuses,
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    );
  });

  app.get('/api/presence/drafts/:id', (c) => {
    const row = getDraft(getDb(), c.req.param('id'));
    if (!row) return c.json({ error: 'draft_not_found' }, 404);
    return c.json(row);
  });

  app.post('/api/presence/drafts', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = DraftCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    const { source_id, external_thread_id, external_thread_url, ...rest } = parsed.data;
    const row = createDraft(getDb(), {
      ...rest,
      source_id: source_id ?? null,
      external_thread_id: external_thread_id ?? null,
      external_thread_url: external_thread_url ?? null,
    });
    return c.json(row, 201);
  });

  app.patch('/api/presence/drafts/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = DraftUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    const row = updateDraftBody(getDb(), c.req.param('id'), parsed.data);
    if (!row) return c.json({ error: 'draft_not_found' }, 404);
    return c.json(row);
  });

  // Bulk transition: same target status applied to many drafts in one tx.
  // Used by the feed's multi-select bar ("Selected: 3 → Approve all").
  app.post('/api/presence/drafts/bulk-transition', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = BulkTransitionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    const changed = bulkTransitionDrafts(getDb(), parsed.data.ids, parsed.data.status);
    return c.json({ changed, status: parsed.data.status, requested: parsed.data.ids.length });
  });

  app.post('/api/presence/drafts/:id/transition', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = DraftTransitionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    const row = transitionDraft(getDb(), c.req.param('id'), parsed.data.status, {
      posted_external_id: parsed.data.posted_external_id,
      posted_external_url: parsed.data.posted_external_url,
    });
    if (!row) return c.json({ error: 'draft_not_found' }, 404);
    return c.json(row);
  });

  app.get('/api/presence/drafts/:id/events', (c) => {
    return c.json(listEvents(getDb(), c.req.param('id')));
  });

  // Hard delete one draft (cascades events + engagement; preserves cost ledger).
  app.delete('/api/presence/drafts/:id', (c) => {
    const ok = deleteDraft(getDb(), c.req.param('id'));
    if (!ok) return c.json({ error: 'draft_not_found' }, 404);
    return c.json({ ok: true });
  });

  // Bulk delete by status. Default = all terminal statuses ("clear archived").
  app.delete('/api/presence/drafts', (c) => {
    const raw = c.req.query('statuses');
    const allowed = PRESENCE_DRAFT_STATUSES as readonly string[];
    const statuses = (raw ? raw.split(',') : ['expired', 'ignored', 'rejected'])
      .map((s) => s.trim())
      .filter((s) => allowed.includes(s)) as z.infer<typeof DraftStatusSchema>[];
    if (statuses.length === 0) return c.json({ error: 'no_valid_statuses' }, 400);
    const removed = bulkDeleteDrafts(getDb(), statuses);
    return c.json({ removed, statuses });
  });

  app.get('/api/presence/drafts/:id/engagement', (c) => {
    return c.json(listDraftEngagement(getDb(), c.req.param('id')));
  });

  app.post('/api/presence/drafts/:id/engagement', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = EngagementRecordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    const id = c.req.param('id');
    if (!getDraft(getDb(), id)) return c.json({ error: 'draft_not_found' }, 404);
    recordEngagement(getDb(), { draft_id: id, ...parsed.data });
    return c.json({ ok: true });
  });

  // ─── Maintenance ────────────────────────────────────
  app.post('/api/presence/expire', (c) => {
    const n = expireStaleDrafts(getDb());
    return c.json({ expired: n });
  });

  // ─── Connections ────────────────────────────────────
  app.get('/api/presence/connections', (c) => {
    return c.json(listConnections(getDb()));
  });

  app.post('/api/presence/connections', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = ConnectionUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    return c.json(upsertConnection(getDb(), parsed.data));
  });

  app.delete('/api/presence/connections/:platform', (c) => {
    const platform = c.req.param('platform') as z.infer<typeof PlatformSchema>;
    if (!PRESENCE_PLATFORMS.includes(platform)) {
      return c.json({ error: 'invalid_platform' }, 400);
    }
    const ok = deleteConnection(getDb(), platform);
    if (!ok) return c.json({ error: 'connection_not_found' }, 404);
    return c.json({ ok: true });
  });

  // ─── Feed summary (nav badge) ─────────────────────
  // Cheap counts read by the nav badge poller every ~30 s. Aggregates
  // entirely in SQLite, no LLM, no external calls.
  app.get('/api/presence/feed-summary', (c) => {
    return c.json(getFeedSummary(getDb()));
  });

  // ─── Stats ──────────────────────────────────────────
  app.get('/api/presence/stats', (c) => {
    const rawWindow = Number.parseInt(c.req.query('windowDays') || '30', 10);
    const windowDays = Number.isFinite(rawWindow) ? Math.min(365, Math.max(1, rawWindow)) : 30;
    return c.json(getOverviewStats(getDb(), windowDays));
  });

  // ─── Scan now (async, returns 202 + job id) ────────
  //
  // The previous synchronous implementation blocked the HTTP request for 5+
  // minutes while the scanner walked candidates and called the Claude CLI.
  // The new flow returns immediately with a job id; the client polls the
  // /scan-jobs/:id endpoint to track progress and pick up the outcome when
  // status flips to 'done'.
  //
  // For backwards-compat with anything that still expects a sync scan, the
  // legacy synchronous path is kept under /scan-sync (no UI consumer).
  app.post('/api/presence/scan-now', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScanNowSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    try {
      const settings = await loadSettings();
      // Manual scan-now bypasses the per-source TTL gate so the user can
      // force a fresh scan even on sources that just ran. The daily budget
      // cap still applies as a safety net.
      const job = enqueueScan(getDb(), settings, {
        onlyPlatform: parsed.data.platform,
        onlySourceId: parsed.data.source_id,
        bypassTtl: true,
      });
      return c.json(
        {
          job_id: job.id,
          status: job.status,
          enqueued_at: job.enqueued_at,
        },
        202,
      );
    } catch (error) {
      return c.json({ error: 'enqueue_failed', details: String(error) }, 500);
    }
  });

  app.post('/api/presence/scan-sync', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScanNowSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    try {
      const settings = await loadSettings();
      const outcome = await runPresenceScan(getDb(), settings, {
        onlyPlatform: parsed.data.platform,
        onlySourceId: parsed.data.source_id,
      });
      return c.json(outcome);
    } catch (error) {
      return c.json({ error: 'scan_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/presence/scan-jobs', (c) => {
    const limit = Number.parseInt(c.req.query('limit') || '20', 10);
    return c.json(listRecentJobs(Number.isFinite(limit) ? limit : 20));
  });

  app.get('/api/presence/scan-jobs/:id', (c) => {
    const job = getJob(c.req.param('id'));
    if (!job) return c.json({ error: 'job_not_found' }, 404);
    return c.json(job);
  });

  // ─── Translation (preview-only — caller PATCHes to commit) ────────
  //
  // Translates the draft body to FR/EN/ES via the Claude/Codex CLI. Returns
  // the translated string without persisting; the client decides whether to
  // replace the body via a separate PATCH (so the user can compare both
  // versions before committing).
  app.post('/api/presence/drafts/:id/translate', async (c) => {
    const id = c.req.param('id');
    const draft = getDraft(getDb(), id);
    if (!draft) return c.json({ error: 'draft_not_found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const parsed = TranslateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    try {
      const settings = await loadSettings();
      const res = await translateDraft(
        getDb(),
        settings,
        id,
        draft.draft_body,
        parsed.data.target_lang,
      );
      // Track translation generated → feeds quality stats. Saved/discarded
      // are tracked at the events endpoint below (called by the UI when the
      // user commits or abandons a translation).
      recordEvent(getDb(), id, 'translation_generated', { lang: parsed.data.target_lang });
      return c.json(res);
    } catch (error) {
      return c.json({ error: 'translate_failed', details: String(error) }, 502);
    }
  });

  // Lightweight event endpoint for translation outcome (saved / discarded).
  // Distinct from /transition because it only writes to the event log,
  // doesn't mutate draft state. Used by the language tabs UI to log when
  // the user commits a translation vs swaps back to the original without
  // saving — feeds the "FR translations approved 40%" stat.
  app.post('/api/presence/drafts/:id/translation-event', async (c) => {
    const id = c.req.param('id');
    const draft = getDraft(getDb(), id);
    if (!draft) return c.json({ error: 'draft_not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        outcome: z.enum(['translation_saved', 'translation_discarded']),
        lang: z.enum(['fr', 'en', 'es']),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    recordEvent(getDb(), id, parsed.data.outcome, { lang: parsed.data.lang });
    return c.json({ ok: true });
  });

  // ─── Image generation (lazy) ───────────────────────
  app.post('/api/presence/drafts/:id/image', async (c) => {
    const id = c.req.param('id');
    const draft = getDraft(getDb(), id);
    if (!draft) return c.json({ error: 'draft_not_found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const parsed = ImageGenSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    if (!(await openrouterIsConfigured())) {
      return c.json({ error: 'openrouter_not_configured' }, 409);
    }

    // If caller didn't pass kind/prompt, run the classifier.
    let kind = parsed.data.kind;
    let prompt = parsed.data.prompt ?? null;
    if (!kind || !prompt) {
      try {
        const settings = await loadSettings();
        const plan = await classifyImageNeed(getDb(), settings, id, draft.draft_body);
        kind = kind ?? (plan.kind === 'none' ? undefined : plan.kind);
        prompt = prompt ?? plan.prompt;
        if (plan.kind === 'none') {
          return c.json({ kind: 'none', reason: plan.reason });
        }
      } catch (error) {
        return c.json({ error: 'classify_failed', details: String(error) }, 502);
      }
    }

    if (!kind || !prompt) {
      return c.json({ error: 'missing_kind_or_prompt' }, 400);
    }

    // Diagrams render client-side from mermaid code; we return the prompt as
    // the mermaid source and skip the image API entirely (free).
    if (kind === 'diagram') {
      const plan = {
        kind,
        prompt,
        mermaid: prompt,
        model: null,
        url: null,
        b64: null,
        cost_usd: 0,
      };
      updateDraftBody(getDb(), id, { image_plan: plan });
      return c.json(plan);
    }

    const model = IMAGE_MODEL_BY_KIND[kind];
    if (!model) return c.json({ error: 'invalid_kind' }, 400);

    try {
      const res = await orImage({ model, prompt });
      const cost = estimateImageCost(res.model, res.usage);
      recordCost(getDb(), {
        draft_id: id,
        service: 'openrouter',
        operation: 'image_gen',
        units: res.usage?.total_tokens ?? 1,
        unit_cost_usd: cost,
        total_usd: cost,
        meta: { model: res.model, kind, usage: res.usage },
      });
      const plan = {
        kind,
        prompt,
        model: res.model,
        url: res.url,
        b64: res.b64,
        cost_usd: cost,
      };
      updateDraftBody(getDb(), id, { image_plan: plan });
      return c.json(plan);
    } catch (error) {
      return c.json({ error: 'image_gen_failed', details: String(error) }, 502);
    }
  });

  // ─── Platform connect flows ────────────────────────
  //
  // Secrets go through Keychain (see ../wrappers/*), never SQLite. The
  // presence_platform_connections row only tracks the account handle +
  // connected_at timestamp for display. Disconnecting wipes both sides.

  app.get('/api/presence/connect/status', async (c) => {
    const [reddit, x, openrouter] = await Promise.all([
      redditIsConnected(),
      xIsConnected(),
      openrouterIsConfigured(),
    ]);
    return c.json({ reddit, x, openrouter });
  });

  app.post('/api/presence/connect/reddit', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = RedditConnectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    // Live-validate the kit by calling /api/v1/me. Previously we swallowed
    // the whoami error with .catch(() => null), which made invalid creds
    // look "connected" until the user later tried to post and hit a 401.
    // Now we delete the just-saved creds on validation failure so the
    // status stays accurate.
    try {
      await saveRedditCreds(parsed.data);
      let whoami: { name: string; link_karma: number; comment_karma: number } | null = null;
      try {
        whoami = await redditWhoami();
      } catch (whoamiError) {
        await deleteRedditCreds().catch(() => null);
        return c.json(
          {
            error: 'reddit_creds_rejected_by_server',
            details: `Reddit rejected the credentials: ${String(whoamiError).slice(0, 300)}`,
          },
          401,
        );
      }
      upsertConnection(getDb(), {
        platform: 'reddit',
        account_handle: whoami.name,
      });
      return c.json({ ok: true, account: whoami });
    } catch (error) {
      return c.json({ error: 'reddit_connect_failed', details: String(error) }, 502);
    }
  });

  app.post('/api/presence/connect/x', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = XConnectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    try {
      await saveXCreds({ bearer: parsed.data.bearer, username: parsed.data.username });
      const whoami = parsed.data.username ? await xWhoami().catch(() => null) : null;
      upsertConnection(getDb(), {
        platform: 'x',
        account_handle: whoami?.username ?? parsed.data.username ?? null,
      });
      return c.json({ ok: true, account: whoami });
    } catch (error) {
      return c.json({ error: 'x_connect_failed', details: String(error) }, 502);
    }
  });

  app.post('/api/presence/connect/openrouter', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = OpenrouterConnectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    try {
      await saveOpenrouterKey(parsed.data.apiKey);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: 'openrouter_save_failed', details: String(error) }, 502);
    }
  });

  // ─── Drafter provider / model config ───────────────
  app.get('/api/presence/drafter-config', async (c) => {
    const settings = await loadSettings();
    const db = getDb();
    const [claudeModels, codexModels] = await Promise.all([
      getMergedAgentModels(db, 'claude').catch(() => []),
      getMergedAgentModels(db, 'codex').catch(() => []),
    ]);
    return c.json({
      config: settings.presence,
      catalog: { claude: claudeModels, codex: codexModels },
    });
  });

  // Scheduler config: toggle the auto-scan gate + adjust cadences.
  // Returns the same shape as GET /scheduler-config so the client can
  // refresh state from the response.
  app.get('/api/presence/scheduler-config', async (c) => {
    const settings = await loadSettings();
    // Today's spend is included so the UI can show "$X spent / $Y cap" and
    // colour the cap input warn/danger as the user nears the limit.
    const todaySpend = getDb()
      .query<{ total: number | null }, []>(
        `SELECT SUM(total_usd) AS total FROM presence_cost_ledger
          WHERE at >= unixepoch('now', 'start of day', 'localtime')`,
      )
      .get();
    return c.json({
      autoScanEnabled: settings.presence?.autoScanEnabled ?? false,
      scanIntervalMinutes: settings.schedules.presenceScanMinutes,
      engagementPollIntervalMinutes: settings.schedules.presenceEngagementPollMinutes,
      dailyBudgetUsd: settings.presence?.dailyBudgetUsd ?? 0,
      todaySpendUsd: Math.round((todaySpend?.total ?? 0) * 10000) / 10000,
      engagementPollEnabled: settings.presence?.engagementPollEnabled ?? true,
    });
  });

  app.post('/api/presence/scheduler-config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = SchedulerConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    try {
      const current = await loadSettings();
      const next = {
        ...current,
        presence: {
          ...current.presence,
          autoScanEnabled: parsed.data.autoScanEnabled,
          dailyBudgetUsd: parsed.data.dailyBudgetUsd ?? current.presence.dailyBudgetUsd,
          engagementPollEnabled:
            parsed.data.engagementPollEnabled ?? current.presence.engagementPollEnabled,
        },
        schedules: {
          ...current.schedules,
          presenceScanMinutes:
            parsed.data.scanIntervalMinutes ?? current.schedules.presenceScanMinutes,
          presenceEngagementPollMinutes:
            parsed.data.engagementPollIntervalMinutes ??
            current.schedules.presenceEngagementPollMinutes,
        },
      };
      await saveSettings(next);
      return c.json({
        ok: true,
        autoScanEnabled: next.presence.autoScanEnabled,
        scanIntervalMinutes: next.schedules.presenceScanMinutes,
        engagementPollIntervalMinutes: next.schedules.presenceEngagementPollMinutes,
        dailyBudgetUsd: next.presence.dailyBudgetUsd,
        engagementPollEnabled: next.presence.engagementPollEnabled,
      });
    } catch (error) {
      return c.json({ error: 'save_failed', details: String(error) }, 500);
    }
  });

  app.post('/api/presence/drafter-config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = DrafterConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    try {
      const current = await loadSettings();
      // Merge into existing presence config so we don't blow away
      // xReadCostUsd (and any future field) when only drafter knobs change.
      const next = {
        ...current,
        presence: { ...current.presence, ...parsed.data },
      };
      await saveSettings(next);
      return c.json({ ok: true, config: next.presence });
    } catch (error) {
      return c.json({ error: 'save_failed', details: String(error) }, 500);
    }
  });

  app.delete('/api/presence/connect/:platform', async (c) => {
    const platform = c.req.param('platform');
    try {
      if (platform === 'reddit') {
        await deleteRedditCreds();
        deleteConnection(getDb(), 'reddit');
      } else if (platform === 'x') {
        await deleteXCreds();
        deleteConnection(getDb(), 'x');
      } else if (platform === 'openrouter') {
        await deleteOpenrouterKey();
      } else {
        return c.json({ error: 'invalid_platform' }, 400);
      }
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: 'disconnect_failed', details: String(error) }, 500);
    }
  });
}
