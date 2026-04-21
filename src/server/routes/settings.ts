import type { Hono } from 'hono';
import { SettingsSchema, loadSettings, saveSettings } from '../config';

export function registerSettingsRoutes(app: Hono): void {
  app.get('/api/settings', async (c) => {
    const settings = await loadSettings();
    return c.json(settings);
  });

  app.put('/api/settings', async (c) => {
    const body = await c.req.json();
    const parsed = SettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_settings', details: parsed.error.flatten() }, 400);
    }

    await saveSettings(parsed.data);
    return c.json(parsed.data);
  });
}
