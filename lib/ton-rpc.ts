import axios, { type AxiosAdapter } from 'axios';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isTimeout(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e.code === 'ECONNABORTED' ||
    e.code === 'ETIMEDOUT' ||
    /timeout/i.test(e.message ?? '')
  );
}

const baseAdapter = axios.getAdapter(axios.defaults.adapter);

export const rpcAdapter: AxiosAdapter = async (config) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await baseAdapter(config);
    } catch (err) {
      const e = err as { response?: { status?: number }; code?: string; message?: string };
      const retryable = e.response?.status === 429 || isTimeout(err);
      if (!retryable) throw err;
      const wait = Math.min(3000 * (attempt + 1), 15_000);
      console.log(`rpc ${e.response?.status ?? e.code}: ждём ${wait} мс…`);
      await sleep(wait);
    }
  }
  throw new Error('toncenter недоступен после повторов');
};

export async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status !== 429 && !isTimeout(err)) throw err;
      const wait = 2000 * (attempt + 1);
      console.log(`${label}: ${status ?? 'timeout'}, ждём ${wait} мс…`);
      await sleep(wait);
    }
  }
  throw new Error(`${label}: toncenter недоступен после повторов`);
}
