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
/** Запросы, которые уже выполняются: параллельные обращения ждут один результат. */
const pending = new Map<string, Promise<unknown>>();
const MAX_ENTRIES = 500;

export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }

  const inflight = pending.get(key) as Promise<T> | undefined;
  if (inflight) {
    return inflight;
  }

  const promise = loader()
    .then((value) => {
      if (store.size >= MAX_ENTRIES) {
        const oldest = store.keys().next().value;
        if (oldest) store.delete(oldest);
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      pending.delete(key);
    });

  pending.set(key, promise);
  return promise;
}

export function cacheStats() {
  return { entries: store.size };
}
