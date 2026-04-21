import { z } from 'zod';

export const ProjectTypeSchema = z.enum([
  'node',
  'python',
  'rust',
  'go',
  'git',
  'mixed',
  'generic',
]);

export const HealthFactorSchema = z.object({
  weight: z.number(),
  value: z.number(),
  label: z.string(),
  reason: z.string(),
});

export const HealthBreakdownSchema = z.object({
  factors: z.record(z.string(), HealthFactorSchema),
  score: z.number(),
});

export type HealthFactor = z.infer<typeof HealthFactorSchema>;
export type HealthBreakdown = z.infer<typeof HealthBreakdownSchema>;

export const ProjectSummarySchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  type: z.string(),
  description: z.string().nullable(),
  last_modified: z.number(),
  last_commit_at: z.number().nullable(),
  git_branch: z.string().nullable(),
  uncommitted: z.number(),
  health_score: z.number(),
  health_breakdown_json: z.string().nullable().optional(),
  loc: z.number().nullable(),
  languages_json: z.string().nullable(),
});

export const ProjectDetailSchema = ProjectSummarySchema.extend({
  readme_path: z.string().nullable(),
  git_remote: z.string().nullable(),
  scanned_at: z.number(),
});

export const GithubHeatmapDaySchema = z.object({
  date: z.string(),
  count: z.number(),
  color: z.string().nullable(),
});

export const GithubRepoSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  stars: z.number(),
  forks: z.number(),
  primary_lang: z.string().nullable(),
  topics_json: z.string().nullable(),
  pushed_at: z.number().nullable(),
});

export const UsageDailySchema = z.object({
  date: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_create: z.number(),
  cache_read: z.number(),
  cost_usd: z.number(),
  source: z.string(),
});

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;
export type GithubHeatmapDay = z.infer<typeof GithubHeatmapDaySchema>;
export type GithubRepo = z.infer<typeof GithubRepoSchema>;
export type UsageDaily = z.infer<typeof UsageDailySchema>;
