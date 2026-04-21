import { loadSettings, saveSettings } from '../src/server/config';

const existing = await loadSettings();
await saveSettings(existing);

console.log('Settings initialized: data/settings.json');
console.log(`projectsRoots: ${existing.paths.projectsRoots.join(', ')}`);
console.log(`vaultPath: ${existing.paths.vaultPath}`);
console.log(`github.username: ${existing.github.username}`);
