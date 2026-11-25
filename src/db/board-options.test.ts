import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from './index.js';
import { seed } from './seed.js';
import { writeItem } from './queue.js';
import { beginItemLease, currentLeaseItem } from './item-lease.js';
import { browserDiscoveryEnabled, setBrowserDiscovery } from './board-options.js';
import { deleteBoardCascade } from './board-actions.js';
import { getSetting } from './settings.js';

test('board opt-in is strict, isolated, restart/backup durable, and invalidates ABA leases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-options-')), file = join(dir, 'db.sqlite');
  let handle = initDb(file);
  try {
    seed(handle.db);
    assert.equal(browserDiscoveryEnabled(handle, 'library'), false);
    await assert.rejects(setBrowserDiscovery(handle, 'library', 'true' as never), /boolean/);
    await assert.rejects(setBrowserDiscovery(handle, 'missing', true), /Unknown board/);
    await writeItem(handle, { id: 'item', boardId: 'library', source: 'https://example.com' });
    await setBrowserDiscovery(handle, 'library', true);
    const lease = beginItemLease(handle, 'item');
    await setBrowserDiscovery(handle, 'library', false);
    await setBrowserDiscovery(handle, 'library', true);
    assert.equal(currentLeaseItem(handle, lease), undefined);
    assert.equal(browserDiscoveryEnabled(handle, 'inspiration'), false);
    handle.sqlite.close();
    copyFileSync(file, join(dir, 'backup.sqlite'));
    handle = initDb(join(dir, 'backup.sqlite'));
    assert.equal(browserDiscoveryEnabled(handle, 'library'), true);
    assert.equal(browserDiscoveryEnabled(handle, 'inspiration'), false);
    await deleteBoardCascade(handle, 'library', dir);
    assert.equal(getSetting(handle, 'board:library:browser-discovery'), undefined);
    seed(handle.db);
    assert.equal(browserDiscoveryEnabled(handle, 'library'), false);
  } finally { handle.sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
});
