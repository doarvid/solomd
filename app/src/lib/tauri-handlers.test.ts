/**
 * The Tauri app binary's real invoke handler lives in `src-tauri/src/runner.rs`,
 * not `lib.rs` (runner.rs is the bin's compile root and re-declares every
 * module with `#[path]`). A command registered only in lib.rs passes every
 * Rust unit test and then fails at runtime with "Command <name> not found".
 *
 * This test keeps the two lists honest: every cross-platform command the lib
 * registers must also be registered by the binary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../src-tauri/src/', import.meta.url);

/** Modules whose commands are registered per-platform, so the two files differ. */
const PLATFORM_ONLY = ['saf_android::', 'storage_android::'];

function handlerCommands(file: string): Set<string> {
  const path = fileURLToPath(new URL(file, ROOT));
  const src = readFileSync(path, 'utf8');
  const open = src.indexOf('[', src.indexOf('tauri::generate_handler!'));
  assert.ok(open >= 0, `${file}: generate_handler! not found`);

  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) {
      close = i;
      break;
    }
  }
  assert.ok(close > open, `${file}: unterminated generate_handler!`);

  const commands = new Set<string>();
  for (const line of src.slice(open + 1, close).split('\n')) {
    if (/^\s*#\[cfg/.test(line)) continue;
    const m = line.match(/^\s+([a-z_][a-z0-9_]*::[a-z_][a-z0-9_]*),?\s*$/);
    if (m) commands.add(m[1]);
  }
  return commands;
}

test('the app binary registers every cross-platform command the lib knows', () => {
  const lib = handlerCommands('lib.rs');
  const bin = handlerCommands('runner.rs');

  const missing = [...lib].filter(
    (cmd) =>
      !bin.has(cmd) && !PLATFORM_ONLY.some((prefix) => cmd.startsWith(prefix)),
  );

  assert.deepEqual(
    missing,
    [],
    `runner.rs is missing: ${missing.join(', ')} — the app will fail with "Command not found"`,
  );
});
