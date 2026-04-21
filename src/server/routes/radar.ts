import type { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db';
import {
  addManualCompetitor,
  deleteCompetitor,
  generateInsights,
  getRadarSummary,
  listCompetitorsByProject,
  listInsights,
  promoteInsightToVault,
  scanCompetitors,
  updateInsightStatus,
  updateManualCompetitor,
} from '../lib/radar';
import { rateLimit } from '../lib/rateLimit';

// Max 3 scans / generates per minute per project. The CLI call behind each
// costs ~10s + real API tokens; a user tapping the button twice or a reload
// loop would otherwise blow through quota.
const scanLimiter = rateLimit(3, 60_000);
const generateLimiter = rateLimit(3, 60_000);

const CompetitorCreateSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url().max(500).optional().nullable(),
  pitch: z.string().max(500).optional().nullable(),
});

const CompetitorUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  url: z.string().url().max(500).optional().nullable(),
  pitch: z.string().max(500).optional().nullable(),
});

const INSIGHT_STATUS_VALUES = ['pending', 'explored', 'dismissed'] as const;
type InsightStatus = (typeof INSIGHT_STATUS_VALUES)[number];

const InsightStatusSchema = z.object({
  status: z.enum(INSIGHT_STATUS_VALUES),
});

function projectExists(id: string): boolean {
  const row = getDb()
    .query<{ id: string }, [string]>('SELECT id FROM projects WHERE id = ?')
    .get(id);
  return Boolean(row);
}

export function registerRadarRoutes(app: Hono): void {
  app.get('/api/radar/summary', (c) => {
    return c.json(getRadarSummary(getDb()));
  });

  app.get('/api/projects/:id/competitors', (c) => {
    const id = c.req.param('id');
    if (!projectExists(id)) return c.json({ error: 'project_not_found' }, 404);
    return c.json(listCompetitorsByProject(getDb(), id));
  });

  app.post('/api/projects/:id/competitors', async (c) => {
    const id = c.req.param('id');
    if (!projectExists(id)) return c.json({ error: 'project_not_found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const parsed = CompetitorCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    const row = addManualCompetitor(getDb(), id, parsed.data);
    return c.json(row);
  });

  app.patch('/api/competitors/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CompetitorUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    const row = updateManualCompetitor(getDb(), c.req.param('id'), parsed.data);
    if (!row) {
      return c.json({ error: 'competitor_not_editable' }, 404);
    }
    return c.json(row);
  });

  app.delete('/api/competitors/:id', (c) => {
    const ok = deleteCompetitor(getDb(), c.req.param('id'));
    if (!ok) return c.json({ error: 'competitor_not_found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/projects/:id/competitors/scan', async (c) => {
    const id = c.req.param('id');
    if (!projectExists(id)) return c.json({ error: 'project_not_found' }, 404);

    const verdict = scanLimiter.check(`scan:${id}`);
    if (!verdict.ok) {
      return c.json({ error: 'rate_limited', retryAfterMs: verdict.retryAfterMs }, 429, {
        'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)),
      });
    }

    try {
      const res = await scanCompetitors(id);
      return c.json(res, res.run.ok ? 200 : 502);
    } catch (error) {
      return c.json({ error: 'scan_failed', details: String(error) }, 500);
    }
  });

  app.post('/api/projects/:id/insights/generate', async (c) => {
    const id = c.req.param('id');
    if (!projectExists(id)) return c.json({ error: 'project_not_found' }, 404);

    const verdict = generateLimiter.check(`generate:${id}`);
    if (!verdict.ok) {
      return c.json({ error: 'rate_limited', retryAfterMs: verdict.retryAfterMs }, 429, {
        'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)),
      });
    }

    try {
      const res = await generateInsights(id);
      return c.json(res, res.run.ok ? 200 : 502);
    } catch (error) {
      return c.json({ error: 'generate_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/insights', (c) => {
    const projectId = c.req.query('projectId') || undefined;
    const rawStatus = c.req.query('status') || 'pending';
    const status = INSIGHT_STATUS_VALUES.includes(rawStatus as InsightStatus)
      ? (rawStatus as InsightStatus)
      : 'pending';
    const rawLimit = Number.parseInt(c.req.query('limit') || '100', 10);
    // Plafond 500 : résultset visible dans l'UI reste navigable, évite de matérialiser 10k+ rows.
    const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, rawLimit)) : 100;
    const rows = listInsights(getDb(), { projectId, status, limit });
    return c.json(rows);
  });

  app.post('/api/insights/:id/promote', async (c) => {
    try {
      const res = await promoteInsightToVault(c.req.param('id'));
      if (!res.ok) return c.json({ error: res.reason }, 404);
      return c.json({ ok: true, path: res.path, abs: res.abs });
    } catch (error) {
      return c.json({ error: 'promote_failed', details: String(error) }, 500);
    }
  });

  app.post('/api/insights/:id/status', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = InsightStatusSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    const row = updateInsightStatus(getDb(), c.req.param('id'), parsed.data.status);
    if (!row) return c.json({ error: 'insight_not_found' }, 404);
    return c.json(row);
  });
}
