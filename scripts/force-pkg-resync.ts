#!/usr/bin/env bun
// One-off: force a full package_downloads refresh, bypassing the 6h TTL
// cache. Useful after upgrading the detection logic.
import { loadSettings } from '../src/server/config';
import { getDb } from '../src/server/db';
import { refreshAllPackageDownloads } from '../src/server/lib/packageDownloads';

const db = getDb();
const settings = await loadSettings();
console.log('aliases:', settings.displayAliases);
const start = Date.now();
const result = await refreshAllPackageDownloads({
  db,
  force: true,
  displayAliases: settings.displayAliases,
});
console.log(`done in ${Date.now() - start} ms`);
console.log(JSON.stringify(result, null, 2));
