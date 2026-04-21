import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiGet } from './api';

export type UseApiState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: null; error: ApiError | Error };

export type UseApiResult<T> = UseApiState<T> & {
  reload: () => void;
  setData: (value: T) => void;
};

export function useApi<T>(
  path: string | null,
  options: { deps?: ReadonlyArray<unknown> } = {},
): UseApiResult<T> {
  const [state, setState] = useState<UseApiState<T>>({
    status: 'loading',
    data: null,
    error: null,
  });
  const [reloadKey, setReloadKey] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!path) {
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading', data: null, error: null });

    apiGet<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!mountedRef.current || controller.signal.aborted) {
          return;
        }
        setState({ status: 'success', data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        if (!mountedRef.current) {
          return;
        }
        const normalized =
          error instanceof ApiError
            ? error
            : error instanceof Error
              ? error
              : new Error(String(error));
        setState({ status: 'error', data: null, error: normalized });
      });

    return () => {
      controller.abort();
    };
  }, [path, reloadKey, ...(options.deps || [])]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const setData = useCallback((value: T) => {
    if (!mountedRef.current) {
      return;
    }
    setState({ status: 'success', data: value, error: null });
  }, []);

  return { ...state, reload, setData } as UseApiResult<T>;
}
