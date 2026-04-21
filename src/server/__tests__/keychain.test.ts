import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { platform } from 'node:os';
import {
  type SecretStore,
  __setKeychainBackendForTests,
  _internals,
  keychain,
} from '../lib/keychain';

describe('keychain dispatch (fake backend)', () => {
  beforeAll(() => {
    const mem = new Map<string, string>();
    const fake: SecretStore = {
      async get(account, service = 'vibecode-dash') {
        const k = `${service}/${account}`;
        const v = mem.get(k);
        if (v === undefined) throw new Error(`missing ${k}`);
        return v;
      },
      async set(account, value, service = 'vibecode-dash') {
        mem.set(`${service}/${account}`, value);
      },
      async delete(account, service = 'vibecode-dash') {
        mem.delete(`${service}/${account}`);
      },
    };
    __setKeychainBackendForTests(fake);
  });

  afterAll(() => {
    __setKeychainBackendForTests(null);
  });

  test('round-trips a secret', async () => {
    await keychain.set('test-account', 's3cr3t');
    expect(await keychain.get('test-account')).toBe('s3cr3t');
    await keychain.delete('test-account');
    await expect(keychain.get('test-account')).rejects.toThrow();
  });

  test('isolates by service', async () => {
    await keychain.set('shared', 'A', 'svc-a');
    await keychain.set('shared', 'B', 'svc-b');
    expect(await keychain.get('shared', 'svc-a')).toBe('A');
    expect(await keychain.get('shared', 'svc-b')).toBe('B');
  });
});

// Windows file-naming sanity — runs on every OS since the helper is pure.
describe('windows secret file naming', () => {
  test('sanitizes unsafe characters', () => {
    const f = _internals.secretFile('vibecode-dash', 'github/pat:1');
    expect(f).toMatch(/vibecode-dash__github_pat_1\.dpapi$/);
  });
});

// Integration test against the real OS backend. Opt-in via env var so CI on
// other OSes (and ordinary local test runs) don't push junk into the keyring.
const skipIntegration = platform() !== 'darwin' || process.env.KEYCHAIN_INTEGRATION !== '1';

describe.skipIf(skipIntegration)('macOS keychain integration', () => {
  const SERVICE = 'vibecode-dash-test';
  const ACCOUNT = `test-${Date.now()}`;

  test('real round-trip via security(1)', async () => {
    await _internals.macKeychain.set(ACCOUNT, 'hello', SERVICE);
    expect(await _internals.macKeychain.get(ACCOUNT, SERVICE)).toBe('hello');
    await _internals.macKeychain.delete(ACCOUNT, SERVICE);
  });
});
