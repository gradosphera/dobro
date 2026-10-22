/**
 * Простой TTL-кэш в памяти экземпляра.
 *
 * На Vercel каждая лямбда живёт ограниченное время, поэтому кэш не общий
 * между инстансами. Для продакшена стоит заменить на @vercel/kv
 * (или Edge Config) — интерфейс здесь совместим с обоими вариантами.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();
const MAX_ENTRIES = 500;

export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }

  const value = await loader();

  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

export function cacheStats() {
  return { entries: store.size };
}
