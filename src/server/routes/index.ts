import type { Hono } from 'hono';
import { registerAgentRoutes } from './agent';
import { registerGithubRoutes } from './github';
import { registerHealthRoutes } from './health';
import { registerObsidianRoutes } from './obsidian';
import { registerPresenceRoutes } from './presence';
import { registerProjectRoutes } from './projects';
import { registerRadarRoutes } from './radar';
import { registerSettingsRoutes } from './settings';
import { registerUsageRoutes } from './usage';

export function registerRoutes(app: Hono): void {
  registerHealthRoutes(app);
  registerSettingsRoutes(app);
  registerProjectRoutes(app);
  registerGithubRoutes(app);
  registerObsidianRoutes(app);
  registerUsageRoutes(app);
  registerAgentRoutes(app);
  registerRadarRoutes(app);
  registerPresenceRoutes(app);
}
