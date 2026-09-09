import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ApiError, type RequestOptions } from './api.js';

/**
 * Data loading.
 *
 * Deliberately small: this application reads a handful of endpoints per screen
 * and a full query library would be more machinery than the problem needs.
 * In-flight requests are aborted when a component unmounts or its key changes,
 * so switching organisation quickly cannot leave a stale response to overwrite
 * a newer one.
 */

export interface Loadable<T> {
  readonly data: T | null;
  readonly error: ApiError | null;
  readonly loading: boolean;
  reload(): void;
}

export function useApi<T>(path: string | null, deps: readonly unknown[] = []): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    setError(null);

    api<T>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught as ApiError);
        setLoading(false);
      });

    return () => controller.abort();
    // The dependency list is spread from a caller-supplied array, which the
    // exhaustive-deps rule cannot verify statically. The contract is stated in
    // the signature instead: the caller passes everything `path` was derived
    // from. `path` itself is a dependency, so a changed URL always refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

export interface Mutation<TInput, TOutput> {
  readonly running: boolean;
  readonly error: ApiError | null;
  readonly result: TOutput | null;
  run(input: TInput): Promise<TOutput | null>;
  reset(): void;
}

export function useMutation<TInput, TOutput>(
  build: (input: TInput) => { path: string; options: RequestOptions },
): Mutation<TInput, TOutput> {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<TOutput | null>(null);

  const run = useCallback(
    async (input: TInput): Promise<TOutput | null> => {
      setRunning(true);
      setError(null);
      try {
        const { path, options } = build(input);
        const output = await api<TOutput>(path, options);
        setResult(output);
        return output;
      } catch (caught) {
        setError(caught as ApiError);
        return null;
      } finally {
        setRunning(false);
      }
    },
    [build],
  );

  const reset = useCallback(() => {
    setError(null);
    setResult(null);
  }, []);

  return { running, error, result, run, reset };
}
