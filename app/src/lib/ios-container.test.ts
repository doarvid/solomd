import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reanchorStorage } from './ios-container.ts';

class MemStorage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const OLD = '11111111-2222-3333-4444-555555555555';
const NEW = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const root = (u: string) => `/private/var/mobile/Containers/Data/Application/${u}`;

describe('reanchorStorage', () => {
  it('moves folders, recents and tab-session keys onto the current container', () => {
    const s = new MemStorage();
    s.setItem('solomd.workspace.v1', JSON.stringify({
      currentFolder: `${root(OLD)}/Documents`,
      recentFolders: [`${root(OLD)}/Documents`, `${root(NEW)}/Documents`, '/private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/笔记'],
      recentFiles: [`${root(OLD)}/Documents/a.md`],
    }));
    s.setItem(`solomd.tabs.v1::${root(OLD)}/Documents`, JSON.stringify({ tabs: [{ filePath: `${root(OLD)}/Documents/a.md` }] }));
    s.setItem('other.key', root(OLD));

    assert.equal(reanchorStorage(s as unknown as Storage, NEW), 2);
    const ws = JSON.parse(s.getItem('solomd.workspace.v1')!);
    assert.equal(ws.currentFolder, `${root(NEW)}/Documents`);
    assert.equal(ws.recentFolders[0], `${root(NEW)}/Documents`);
    assert.ok(ws.recentFolders[1].includes('com~apple~CloudDocs/笔记'));
    assert.equal(ws.recentFolders.length, 2);
    assert.equal(ws.recentFiles[0], `${root(NEW)}/Documents/a.md`);
    assert.equal(s.getItem(`solomd.tabs.v1::${root(OLD)}/Documents`), null);
    assert.ok(s.getItem(`solomd.tabs.v1::${root(NEW)}/Documents`).includes(`${root(NEW)}/Documents/a.md`));
    assert.equal(s.getItem('other.key'), root(OLD));
  });

  it('leaves current paths alone and keeps an existing current-container session', () => {
    const s = new MemStorage();
    s.setItem(`solomd.tabs.v1::${root(NEW)}/Documents`, 'current');
    s.setItem(`solomd.tabs.v1::${root(OLD)}/Documents`, 'stale');
    s.setItem('solomd.workspace.v1', JSON.stringify({ currentFolder: `${root(NEW)}/Documents` }));
    reanchorStorage(s as unknown as Storage, NEW);
    assert.equal(s.getItem(`solomd.tabs.v1::${root(NEW)}/Documents`), 'current');
    assert.equal(s.getItem(`solomd.tabs.v1::${root(OLD)}/Documents`), null);
  });
});
