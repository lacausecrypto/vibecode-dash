import { existsSync, mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appDataDir, currentPlatform } from './platform';

const DEFAULT_SERVICE = 'vibecode-dash';

export interface SecretStore {
  get(account: string, service?: string): Promise<string>;
  set(account: string, value: string, service?: string): Promise<void>;
  delete(account: string, service?: string): Promise<void>;
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  return new Response(stream).text();
}

// ───────────────────────── macOS ─────────────────────────
// Uses the built-in `security` CLI to talk to the login keychain.

const macKeychain: SecretStore = {
  async get(account, service = DEFAULT_SERVICE) {
    const proc = Bun.spawn(
      ['security', 'find-generic-password', '-s', service, '-a', account, '-w'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, code] = await Promise.all([
      drain(proc.stdout),
      drain(proc.stderr),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(err.trim() || `Keychain lookup failed (${service}/${account})`);
    }
    return out.trim();
  },

  async set(account, value, service = DEFAULT_SERVICE) {
    const proc = Bun.spawn(
      ['security', 'add-generic-password', '-U', '-s', service, '-a', account, '-w', value],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [err, code] = await Promise.all([drain(proc.stderr), proc.exited]);
    if (code !== 0) {
      throw new Error(err.trim() || `Keychain write failed (${service}/${account})`);
    }
  },

  async delete(account, service = DEFAULT_SERVICE) {
    const proc = Bun.spawn(['security', 'delete-generic-password', '-s', service, '-a', account], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [err, code] = await Promise.all([drain(proc.stderr), proc.exited]);
    // code 44 = not found; treat as idempotent success
    if (code !== 0 && code !== 44) {
      throw new Error(err.trim() || `Keychain delete failed (${service}/${account})`);
    }
  },
};

// ───────────────────────── Linux ─────────────────────────
// Uses `secret-tool` (part of libsecret, package `libsecret-tools` on Debian/
// Ubuntu, `libsecret` on Fedora/Arch). Talks to GNOME Keyring / KWallet /
// any Secret Service provider. If the binary is missing we fail loud with
// an actionable install hint rather than silently falling back to a file.

async function secretToolInstalled(): Promise<boolean> {
  const proc = Bun.spawn(['sh', '-c', 'command -v secret-tool'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await drain(proc.stdout);
  await drain(proc.stderr);
  return (await proc.exited) === 0;
}

function secretToolMissingError(): Error {
  return new Error(
    'secret-tool not found. Install it to enable secret storage:\n' +
      '  Debian/Ubuntu: sudo apt install libsecret-tools\n' +
      '  Fedora:        sudo dnf install libsecret\n' +
      '  Arch:          sudo pacman -S libsecret\n' +
      'A Secret Service provider (gnome-keyring, KWallet, KeePassXC…) must also be running.',
  );
}

const linuxKeychain: SecretStore = {
  async get(account, service = DEFAULT_SERVICE) {
    if (!(await secretToolInstalled())) throw secretToolMissingError();
    const proc = Bun.spawn(['secret-tool', 'lookup', 'service', service, 'account', account], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      drain(proc.stdout),
      drain(proc.stderr),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(err.trim() || `Keyring lookup failed (${service}/${account})`);
    }
    // secret-tool returns with or without a trailing newline depending on version.
    return out.replace(/\n$/, '');
  },

  async set(account, value, service = DEFAULT_SERVICE) {
    if (!(await secretToolInstalled())) throw secretToolMissingError();
    const proc = Bun.spawn(
      [
        'secret-tool',
        'store',
        '--label',
        `${service} ${account}`,
        'service',
        service,
        'account',
        account,
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    proc.stdin.write(value);
    await proc.stdin.end();
    const [err, code] = await Promise.all([drain(proc.stderr), proc.exited]);
    if (code !== 0) {
      throw new Error(err.trim() || `Keyring write failed (${service}/${account})`);
    }
  },

  async delete(account, service = DEFAULT_SERVICE) {
    if (!(await secretToolInstalled())) throw secretToolMissingError();
    const proc = Bun.spawn(['secret-tool', 'clear', 'service', service, 'account', account], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [err, code] = await Promise.all([drain(proc.stderr), proc.exited]);
    if (code !== 0) {
      throw new Error(err.trim() || `Keyring delete failed (${service}/${account})`);
    }
  },
};

// ───────────────────────── Windows ─────────────────────────
// Uses PowerShell + DPAPI (ConvertFrom-SecureString / ConvertTo-SecureString).
// DPAPI encrypts with the current user's profile key, so only the same OS
// user can decrypt. Encrypted blobs land in %APPDATA%\vibecode-dash\secrets\.
//
// This is the cleanest zero-dependency option on Windows — Credential
// Manager has no PowerShell-native read API without adding a module.

function secretsDir(): string {
  const dir = join(appDataDir(), 'secrets');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function sanitizeComponent(raw: string): string {
  // Allow letters, digits, dash, underscore, dot. Replace the rest.
  return raw.replace(/[^A-Za-z0-9._-]/g, '_');
}

function secretFile(service: string, account: string): string {
  return join(secretsDir(), `${sanitizeComponent(service)}__${sanitizeComponent(account)}.dpapi`);
}

async function runPowerShell(script: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [out, err, code] = await Promise.all([drain(proc.stdout), drain(proc.stderr), proc.exited]);
  if (code !== 0) {
    throw new Error(err.trim() || `PowerShell failed with exit ${code}`);
  }
  return out;
}

const windowsKeychain: SecretStore = {
  async get(account, service = DEFAULT_SERVICE) {
    const file = secretFile(service, account);
    if (!existsSync(file)) {
      throw new Error(`Secret not found (${service}/${account})`);
    }
    const encrypted = (await readFile(file, 'utf8')).trim();
    if (encrypted.length === 0) {
      throw new Error(`Secret empty (${service}/${account})`);
    }
    const script = `
      $secure = ConvertTo-SecureString $env:DPAPI_BLOB
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    `;
    const out = await runPowerShell(script, { DPAPI_BLOB: encrypted });
    return out.replace(/\r?\n$/, '');
  },

  async set(account, value, service = DEFAULT_SERVICE) {
    const script = `
      $secure = ConvertTo-SecureString $env:DPAPI_VALUE -AsPlainText -Force
      ConvertFrom-SecureString $secure
    `;
    const encrypted = (await runPowerShell(script, { DPAPI_VALUE: value })).trim();
    if (encrypted.length === 0) {
      throw new Error(`DPAPI encryption returned empty output (${service}/${account})`);
    }
    await writeFile(secretFile(service, account), encrypted, { encoding: 'utf8', mode: 0o600 });
  },

  async delete(account, service = DEFAULT_SERVICE) {
    const file = secretFile(service, account);
    if (!existsSync(file)) return;
    await unlink(file);
  },
};

// ───────────────────────── Dispatch ─────────────────────────

function pickBackend(): SecretStore {
  switch (currentPlatform()) {
    case 'darwin':
      return macKeychain;
    case 'linux':
      return linuxKeychain;
    case 'win32':
      return windowsKeychain;
  }
}

// Lazy, single instance — lets tests inject a backend without re-importing.
let backend: SecretStore | null = null;

function active(): SecretStore {
  if (!backend) backend = pickBackend();
  return backend;
}

export function __setKeychainBackendForTests(fake: SecretStore | null): void {
  backend = fake;
}

export const keychain: SecretStore = {
  get: (account, service) => active().get(account, service),
  set: (account, value, service) => active().set(account, value, service),
  delete: (account, service) => active().delete(account, service),
};

export const _internals = {
  macKeychain,
  linuxKeychain,
  windowsKeychain,
  secretFile,
};
