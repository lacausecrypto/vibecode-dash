#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const SERVER_ENTRY = join(PKG_ROOT, 'dist', 'server', 'index.js');
const PKG_MANIFEST = join(PKG_ROOT, 'package.json');

const HELP = `vibecode-dash — local-first dashboard for the vibe-coding era

Usage:
  vibecode-dash [options]
  vibecode-dash --help
  vibecode-dash --version

Options:
  -p, --port <n>        Port to bind on 127.0.0.1 (default: 4317, env: PORT)
      --data-dir <dir>  Override data directory (db, settings, token)
                        Default: OS app-data dir (env: VIBECODEDASH_DATA_DIR)
      --no-open         Don't open the browser on startup
  -h, --help            Show this message
  -v, --version         Print version and exit

Examples:
  vibecode-dash
  vibecode-dash --port 7000 --no-open
  VIBECODEDASH_DATA_DIR=/tmp/vcd vibecode-dash

The server binds 127.0.0.1 only. All state (SQLite DB, settings, auth token)
lives under the data dir. See https://github.com/lacausecrypto/vibecode-dash
`;

let parsed;
try {
  parsed = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      'data-dir': { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      open: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: false,
    strict: true,
  });
} catch (err) {
  process.stderr.write(`vibecode-dash: ${err.message}\n\n${HELP}`);
  process.exit(2);
}

const opts = parsed.values;

if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (opts.version) {
  try {
    const pkg = JSON.parse(readFileSync(PKG_MANIFEST, 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
  } catch {
    process.stdout.write('unknown\n');
  }
  process.exit(0);
}

if (!existsSync(SERVER_ENTRY)) {
  process.stderr.write(
    `vibecode-dash: missing build artifact at ${SERVER_ENTRY}\nIf you're running from a clone, run \`bun run build\` first.\n`,
  );
  process.exit(1);
}

process.env.NODE_ENV ??= 'production';
process.env.VIBECODEDASH_PKG_ROOT ??= PKG_ROOT;
if (opts.port) {
  const n = Number.parseInt(opts.port, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    process.stderr.write(`vibecode-dash: --port must be 1..65535, got "${opts.port}"\n`);
    process.exit(2);
  }
  process.env.PORT = String(n);
}
if (opts['data-dir']) {
  process.env.VIBECODEDASH_DATA_DIR = opts['data-dir'];
}

const port = Number.parseInt(process.env.PORT ?? '4317', 10);
const url = `http://127.0.0.1:${port}`;
const shouldOpen = opts.open ?? !opts['no-open'];

if (shouldOpen) {
  // Fire-and-forget: once the server starts listening the URL becomes reachable
  // within a few ms. 400 ms is long enough to avoid a "connection refused" blip
  // in the browser, short enough to feel instant.
  setTimeout(() => {
    openInBrowser(url).catch(() => {
      // Silently ignore — the URL is already printed to stdout.
    });
  }, 400);
}

// Import the bundled server directly. Sharing this process (vs. spawning `bun`)
// means signals propagate naturally: Ctrl-C kills the server and the CLI at
// once, no detached subprocess, no race on shutdown.
await import(SERVER_ENTRY);

async function openInBrowser(target) {
  const os = platform();
  const { cmd, args } =
    os === 'darwin'
      ? { cmd: 'open', args: [target] }
      : os === 'win32'
        ? { cmd: 'cmd', args: ['/c', 'start', '', target] }
        : { cmd: 'xdg-open', args: [target] };

  const proc = Bun.spawn([cmd, ...args], { stdout: 'ignore', stderr: 'ignore' });
  await proc.exited;
}
