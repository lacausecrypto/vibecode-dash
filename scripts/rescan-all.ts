import { loadSettings } from '../src/server/config';
import { closeDb, getDb, runMigrations } from '../src/server/db';
import { scanAllProjects } from '../src/server/scanners/projectScanner';

await runMigrations();
const db = getDb();
const settings = await loadSettings();
const result = await scanAllProjects(db, settings);

console.log(`Scanned ${result.scanned} projects in ${result.durationMs} ms`);
closeDb();
