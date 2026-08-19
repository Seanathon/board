import { eq, sql } from 'drizzle-orm';

import { settings } from './schema.js';
import type { DbHandle } from './index.js';

// A tiny key/value store for runtime-editable config. Deliberately in SQLite rather
// than a sidecar JSON file: the product promise is a single plain file you can copy
// and walk away with, and config that lives outside it makes a copied DB incomplete.
// It also means settings ride along in a backup for free.

/** The raw string, or undefined when the key was never written. */
export function getSetting(handle: DbHandle, key: string): string | undefined {
  const row = handle.db.select().from(settings).where(eq(settings.key, key)).get();
  // `?? undefined` never fires for an empty string — '' is a real value a caller may
  // have set deliberately, and must not read back as "unset".
  return row ? row.value : undefined;
}

/** Upsert. A second write to the same key replaces it rather than duplicating. */
export function setSetting(handle: DbHandle, key: string, value: string): void {
  handle.db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`(unixepoch())` } })
    .run();
}

/** Everything set, for the config surface. */
export function getAllSettings(handle: DbHandle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of handle.db.select().from(settings).all()) out[row.key] = row.value;
  return out;
}
