import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanFontFamilyFromFilename,
  expandAndroidFontPath,
  normalizeFontKey,
  fontMatchesFile,
  discoverLocalFontFiles,
  ensureCustomFontLoaded,
  resetCustomFontCache,
  type DiscoveredFont,
  type TauriInvoker,
} from './custom-font';

test('cleanFontFamilyFromFilename extracts stem and clean family name (#438)', () => {
  assert.deepEqual(cleanFontFamilyFromFilename('LXGWWenKai-Regular.ttf'), {
    stem: 'LXGWWenKai-Regular',
    family: 'LXGWWenKai',
  });
  assert.deepEqual(
    cleanFontFamilyFromFilename('/storage/emulated/0/Fonts/SourceHanSerifSC-Bold.otf'),
    {
      stem: 'SourceHanSerifSC-Bold',
      family: 'SourceHanSerifSC',
    },
  );
  assert.deepEqual(cleanFontFamilyFromFilename('霞鹜文楷.ttf'), {
    stem: '霞鹜文楷',
    family: '霞鹜文楷',
  });
});

test('normalizeFontKey normalizes spaces, hyphens, and style suffixes (#438)', () => {
  assert.equal(normalizeFontKey('LXGW WenKai'), 'lxgwwenkai');
  assert.equal(normalizeFontKey('"LXGWWenKai-Regular.ttf"'), 'lxgwwenkai');
  assert.equal(normalizeFontKey('TsangerJinKai03 W04'), 'tsangerjinkai03');
});

test('fontMatchesFile matches requested font names including CJK aliases (#438)', () => {
  const wenkaiFile: DiscoveredFont = {
    name: 'LXGWWenKai-Regular.ttf',
    path: '/storage/emulated/0/Fonts/LXGWWenKai-Regular.ttf',
    stem: 'LXGWWenKai-Regular',
    family: 'LXGWWenKai',
  };
  assert.equal(fontMatchesFile('LXGW WenKai', wenkaiFile), true);
  assert.equal(fontMatchesFile('LXGWWenKai', wenkaiFile), true);
  assert.equal(fontMatchesFile('LXGWWenKai-Regular', wenkaiFile), true);
  assert.equal(fontMatchesFile('霞鹜文楷', wenkaiFile), true);
  assert.equal(fontMatchesFile('JetBrains Mono', wenkaiFile), false);
});

test('discoverLocalFontFiles scans /storage/emulated/0/Fonts and subdirectories (#438)', async () => {
  resetCustomFontCache();
  const invoker: TauriInvoker = async <T>(cmd: string, args?: Record<string, unknown>) => {
    const path = String(args?.path ?? '');
    if (cmd === 'list_dir' && path === '/storage/emulated/0/Fonts') {
      return [
        { name: 'LXGWWenKai-Regular.ttf', path: '/storage/emulated/0/Fonts/LXGWWenKai-Regular.ttf', is_dir: false },
        { name: 'readme.txt', path: '/storage/emulated/0/Fonts/readme.txt', is_dir: false },
        { name: 'SubPack', path: '/storage/emulated/0/Fonts/SubPack', is_dir: true },
      ] as unknown as T;
    }
    if (cmd === 'list_dir' && path === '/storage/emulated/0/Fonts/SubPack') {
      return [
        { name: 'MapleMono-SC-Regular.woff2', path: '/storage/emulated/0/Fonts/SubPack/MapleMono-SC-Regular.woff2', is_dir: false },
      ] as unknown as T;
    }
    throw new Error('dir not found');
  };

  const files = await discoverLocalFontFiles(['/storage/emulated/0/Fonts'], true, invoker);
  assert.equal(files.length, 2);
  assert.equal(files[0].family, 'LXGWWenKai');
  assert.equal(files[1].family, 'MapleMono-SC');
});

test('ensureCustomFontLoaded registers FontFace for matched local font (#438)', async () => {
  resetCustomFontCache();
  const addedFaces: Array<{ family: string }> = [];
  class FakeFontFace {
    family: string;
    source: BufferSource;
    constructor(family: string, source: BufferSource) {
      this.family = family;
      this.source = source;
    }
    async load() {
      return this;
    }
  }
  (globalThis as unknown as Record<string, unknown>).FontFace = FakeFontFace;
  (globalThis as unknown as Record<string, unknown>).document = {
    fonts: {
      add: (face: { family: string }) => addedFaces.push(face),
    },
  };

  const invoker: TauriInvoker = async <T>(cmd: string, args?: Record<string, unknown>) => {
    const path = String(args?.path ?? '');
    if (cmd === 'list_dir' && path === '/storage/emulated/0/Fonts') {
      return [
        { name: 'LXGWWenKai-Regular.ttf', path: '/storage/emulated/0/Fonts/LXGWWenKai-Regular.ttf', is_dir: false },
      ] as unknown as T;
    }
    if (cmd === 'read_binary_file' && path === '/storage/emulated/0/Fonts/LXGWWenKai-Regular.ttf') {
      return [0, 1, 0, 0] as unknown as T;
    }
    throw new Error('not found');
  };

  const ok = await ensureCustomFontLoaded('霞鹜文楷', invoker);
  assert.equal(ok, true);
  assert.ok(addedFaces.some((f) => f.family === '霞鹜文楷'));
  assert.ok(addedFaces.some((f) => f.family === 'LXGWWenKai'));
});

test('expandAndroidFontPath normalizes ColorOS /storage/0/ paths (#451)', () => {
  const paths = expandAndroidFontPath('/storage/0/Fonts/MyFont.ttf');
  assert.ok(paths.includes('/storage/emulated/0/Fonts/MyFont.ttf'));
});

