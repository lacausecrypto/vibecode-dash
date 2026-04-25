#!/usr/bin/env bun
/**
 * One-shot cropper for the mascot sprites in src/client/assets/clawd/.
 *
 * The source GIFs ship at 302×300 with the character centred and surrounded
 * by transparent padding (animation frames keep a constant bounding box).
 * That padding makes the mascot look "lost in space" when rendered in the
 * sidebar.
 *
 * KEY CONSTRAINT: every sprite must end up at the SAME final dimensions,
 * otherwise the mascot visually jumps size when its state changes
 * (idle → happy → typing etc.). So we don't run --crop-transparency per
 * sprite (which gives variable sizes). Instead we crop ALL sprites to the
 * same fixed window centred on the original 302×300 canvas, picked so it
 * contains every animation's reach (the widest is `happy` at 193×170, so
 * a 200×180 window with a couple px of breathing room covers everyone).
 *
 * Originals are backed up to assets/clawd/.backup-pre-crop/ so the
 * operation is reversible. The script reads from the backup if it exists,
 * making re-runs safe — change the crop window and re-run without losing
 * sources.
 *
 * Requires gifsicle on PATH:
 *   brew install gifsicle
 */

// Uniform crop window on the original 302×300 canvas. Tuned so the widest
// animation (`happy`, 193×170 of content) fits with a few pixels of margin
// on every side, and tall enough to capture animations whose character
// extends near the bottom of the canvas (some characters anchor low rather
// than centred). All sprites get the SAME window so resulting GIFs are
// identical in size and the character anchors don't shift between states.
const CROP_X = 51;
const CROP_Y = 100;
const CROP_W = 200;
const CROP_H = 190;

import { copyFile, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

// `pathname` URL-encodes spaces (and other reserved chars), which
// breaks fs APIs that expect a real filesystem path. Decode once here.
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname);
const SPRITES_DIR = join(ROOT, 'src/client/assets/clawd');
const BACKUP_DIR = join(SPRITES_DIR, '.backup-pre-crop');

type GifInfo = { width: number; height: number; bytes: number };

async function readGifInfo(path: string): Promise<GifInfo> {
  const fileProc = Bun.spawn(['file', path], { stdout: 'pipe', stderr: 'pipe' });
  const [out, code] = await Promise.all([new Response(fileProc.stdout).text(), fileProc.exited]);
  if (code !== 0) throw new Error(`file failed for ${path}`);
  const m = out.match(/(\d+)\s*x\s*(\d+)/);
  if (!m) throw new Error(`could not parse dimensions: ${out}`);
  const st = await stat(path);
  return { width: Number.parseInt(m[1], 10), height: Number.parseInt(m[2], 10), bytes: st.size };
}

async function ensureGifsicle(): Promise<void> {
  const proc = Bun.spawn(['gifsicle', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error('gifsicle not on PATH — install with `brew install gifsicle`');
  }
}

async function cropOne(srcPath: string, outPath: string): Promise<void> {
  // --crop X,Y+WxH: explicit fixed window, same for every sprite, so all
  //   outputs share identical dimensions and the character stays anchored
  //   in the spot it occupied on the original canvas.
  // -o flag writes to a separate file (so we can compare before swapping).
  // --no-warnings silences "local colour table" notices that some sprites
  //   trigger but which are harmless for our use.
  const cropArg = `${CROP_X},${CROP_Y}+${CROP_W}x${CROP_H}`;
  const proc = Bun.spawn(['gifsicle', '--no-warnings', '--crop', cropArg, '-o', outPath, srcPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [, code, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`gifsicle failed for ${srcPath}: ${stderr.trim()}`);
  }
}

async function main(): Promise<void> {
  await ensureGifsicle();

  // If a backup already exists, treat it as the source of truth and crop
  // FROM the backup → SPRITES_DIR. This makes the script idempotent and
  // re-runnable after tuning the crop window without losing originals.
  let backupExists = false;
  try {
    await stat(BACKUP_DIR);
    backupExists = true;
  } catch {
    /* fresh run */
  }

  const sourceDir = backupExists ? BACKUP_DIR : SPRITES_DIR;
  const entries = await readdir(sourceDir);
  const gifs = entries
    .filter((f) => extname(f).toLowerCase() === '.gif')
    .filter((f) => !f.startsWith('.'))
    .sort();

  if (gifs.length === 0) {
    console.log(`No GIFs found in ${sourceDir}`);
    return;
  }

  if (!backupExists) {
    await mkdir(BACKUP_DIR, { recursive: true });
    console.log(`📦 Backing up ${gifs.length} originals to .backup-pre-crop/`);
    for (const name of gifs) {
      await copyFile(join(SPRITES_DIR, name), join(BACKUP_DIR, name));
    }
  } else {
    console.log(`📦 Using existing .backup-pre-crop/ as source (${gifs.length} sprites)`);
  }

  console.log(
    `\n  Crop window: ${CROP_W}×${CROP_H} at offset (${CROP_X}, ${CROP_Y}) — uniform across all sprites`,
  );

  console.log('\n✂  Cropping transparent borders…\n');
  console.log(
    `  ${'sprite'.padEnd(28)} ${'before'.padEnd(15)} ${'after'.padEnd(15)} ${'bytes'.padEnd(20)}`,
  );
  console.log(`  ${'─'.repeat(28)} ${'─'.repeat(15)} ${'─'.repeat(15)} ${'─'.repeat(20)}`);

  let totalSavedBytes = 0;
  for (const name of gifs) {
    const srcPath = join(sourceDir, name);
    const outPath = join(SPRITES_DIR, name);
    const tmpPath = `${outPath}.tmp`;
    const before = await readGifInfo(srcPath);
    await cropOne(srcPath, tmpPath);
    const after = await readGifInfo(tmpPath);
    await rename(tmpPath, outPath);

    const beforeStr = `${before.width}×${before.height}`;
    const afterStr = `${after.width}×${after.height}`;
    const savedBytes = before.bytes - after.bytes;
    totalSavedBytes += savedBytes;
    const sign = savedBytes >= 0 ? '-' : '+';
    const bytesStr = `${(before.bytes / 1024).toFixed(1)}K → ${(after.bytes / 1024).toFixed(1)}K (${sign}${(Math.abs(savedBytes) / 1024).toFixed(1)}K)`;

    console.log(`  ${name.padEnd(28)} ${beforeStr.padEnd(15)} ${afterStr.padEnd(15)} ${bytesStr}`);
  }

  // Stamp the backup dir with a README so future-me remembers what it is.
  await writeFile(
    join(BACKUP_DIR, 'README.md'),
    '# Pre-crop mascot sprite backup\n\n' +
      'Originals snapshotted by `scripts/crop-mascot-sprites.ts` before\n' +
      'running `gifsicle --crop-transparency`. Restore with:\n\n' +
      '```\ncp .backup-pre-crop/*.gif .\nrm -rf .backup-pre-crop\n```\n',
  );

  console.log(
    `\n✓ Done. Total bytes saved: ${(totalSavedBytes / 1024).toFixed(1)}K across ${gifs.length} sprites.`,
  );
  console.log(`  Originals preserved in ${BACKUP_DIR}`);
}

main().catch((err) => {
  console.error('✗ Crop failed:', err);
  process.exit(1);
});
