import { closeDb, runMigrations } from '../src/server/db';

await runMigrations();
closeDb();

console.log('Migrations applied to data/db.sqlite');
