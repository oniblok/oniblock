'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Poll a JSON endpoint. Keeps the last good value on transient errors. */
export function usePoll<T>(url: string, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setData(j as T);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, [url]);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, ms);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, ms]);
  return { data, error, reload: load };
}
