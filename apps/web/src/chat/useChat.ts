import { useCallback, useReducer, useRef } from 'react';
import { createSSEParser } from './parseSSE';
import { chatReducer, initialState } from './reducer';

export function useChat() {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (content: string) => {
    if (stateRef.current.status === 'streaming') return;
    const history = stateRef.current.messages.filter((m) => m.content !== '');
    dispatch({ type: 'start', content });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [...history, { role: 'user', content }],
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        dispatch({ type: 'error', message: `request failed (${res.status})` });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSSEParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          if (event === 'DONE') {
            dispatch({ type: 'done' });
            return;
          }
          if ('delta' in event) {
            dispatch({ type: 'delta', delta: event.delta });
          } else {
            dispatch({ type: 'error', message: event.error });
            return;
          }
        }
      }
      // Stream closed without [DONE]: treat as complete rather than lose text.
      dispatch({ type: 'done' });
    } catch {
      if (controller.signal.aborted) dispatch({ type: 'stop' });
      else dispatch({ type: 'error', message: 'network error' });
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { state, send, stop };
}
