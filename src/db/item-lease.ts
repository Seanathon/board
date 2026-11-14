import { eq } from 'drizzle-orm';
import { boards, items, type Item } from './schema.js';
import type { DbHandle } from './index.js';

// Process/connection-local only: all asynchronous app writers use this lease.
// Direct SQL from other processes is NOT protected against ABA by this mechanism.
const generations = new WeakMap<object, Map<string, symbol>>();
const signalLeases = new WeakMap<AbortSignal, ItemLease>();
export function bindItemLease(signal: AbortSignal, lease: ItemLease | undefined): void {
  if (lease) signalLeases.set(signal, lease);
}
export function signalItemLease(signal?: AbortSignal): ItemLease | undefined {
  return signal ? signalLeases.get(signal) : undefined;
}
export interface ItemLease {
  readonly item: Item;
  readonly descriptor: string;
  readonly token: symbol;
}
function tokens(handle: DbHandle): Map<string, symbol> {
  let map = generations.get(handle.sqlite);
  if (!map) { map = new Map(); generations.set(handle.sqlite, map); }
  return map;
}
export function invalidateItemLease(handle: DbHandle, id: string): void {
  tokens(handle).delete(id);
}
export function invalidateAllItemLeases(handle: DbHandle): void {
  tokens(handle).clear();
}
/** Starting newer work invalidates any older completion, including queued work. */
export function beginItemLease(handle: DbHandle, id: string, supersede = true): ItemLease | undefined {
  const item = handle.db.select().from(items).where(eq(items.id, id)).get();
  if (!item) return undefined;
  const board = handle.db.select().from(boards).where(eq(boards.id, item.boardId)).get();
  if (!board) return undefined;
  const token = (!supersede && tokens(handle).get(id)) || Symbol();
  tokens(handle).set(id, token);
  return { item, descriptor: JSON.stringify(board.descriptor), token };
}
/** Call inside the synchronous write operation, never across an await. */
export function currentLeaseItem(handle: DbHandle, lease: ItemLease | undefined, signal?: AbortSignal): Item | undefined {
  if (!lease || signal?.aborted || tokens(handle).get(lease.item.id) !== lease.token) return undefined;
  const fresh = handle.db.select().from(items).where(eq(items.id, lease.item.id)).get();
  if (!fresh || fresh.boardId !== lease.item.boardId || fresh.source !== lease.item.source || fresh.createdAt !== lease.item.createdAt) return undefined;
  const board = handle.db.select().from(boards).where(eq(boards.id, fresh.boardId)).get();
  return board && JSON.stringify(board.descriptor) === lease.descriptor ? fresh : undefined;
}
/** Presence is significant: a missing field and a deliberately stored null differ. */
export function unchangedField(before: Record<string, unknown>, fresh: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(before, key) === Object.hasOwn(fresh, key) && JSON.stringify(before[key]) === JSON.stringify(fresh[key]);
}

// Manual intent must survive value ABA (including reasserting the same tag value).
const manualRevisions = new WeakMap<object, Map<string, Map<string, symbol>>>();
export function manualFieldSnapshot(handle: DbHandle, id: string): Map<string, symbol> {
  return new Map(manualRevisions.get(handle.sqlite)?.get(id));
}
export function markManualFields(handle: DbHandle, id: string, keys: string[]): void {
  let byItem = manualRevisions.get(handle.sqlite);
  if (!byItem) { byItem = new Map(); manualRevisions.set(handle.sqlite, byItem); }
  let fields = byItem.get(id);
  if (!fields) { fields = new Map(); byItem.set(id, fields); }
  for (const key of keys) fields.set(key, Symbol());
}
export function manualFieldUnchanged(handle: DbHandle, id: string, before: Map<string, symbol>, key: string): boolean {
  return before.get(key) === manualRevisions.get(handle.sqlite)?.get(id)?.get(key);
}
