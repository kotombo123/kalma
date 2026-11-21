/**
 * Live updates: one WebSocket per tab (/ws, F-08). UiEvents are applied to the TanStack Query cache,
 * so every list on screen updates without refetching. After a reconnect, alert lists are refetched.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { UiEvent } from '@alerting/contracts';
import { getToken, onTokenChange, refresh } from './api.ts';
import type { Alert, Page } from './types.ts';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Filters an alert list query was made with — part of its query key. */
export interface AlertFilter {
  status: Alert['status'][];
  severity: Alert['severity'][];
  teamId?: string;
}

/** Alert id → arrival time, for alerts that arrived live in this tab (their rows "ink in"). */
const arrived = new Map<string, number>();
const INK_MS = 1500;
export const isFresh = (id: string) => Date.now() - (arrived.get(id) ?? 0) < INK_MS;

const matches = (f: AlertFilter, a: Alert) =>
  f.status.includes(a.status) && f.severity.includes(a.severity) && (!f.teamId || f.teamId === a.teamId);

function apply(qc: QueryClient, ev: UiEvent) {
  const lists = qc.getQueriesData<Page<Alert>>({ queryKey: ['alerts'] });
  for (const [key, page] of lists) {
    if (!page) continue;
    const filter = key[1] as AlertFilter;
    if (ev.type === 'alert.created') {
      if (!matches(filter, ev.alert) || page.data.some((a) => a.id === ev.alert.id)) continue;
      qc.setQueryData(key, { ...page, data: [ev.alert, ...page.data] });
    } else if (ev.type === 'alert.updated') {
      const i = page.data.findIndex((a) => a.id === ev.alertId);
      if (i < 0) continue;
      const updated = { ...page.data[i]!, ...ev.patch } as Alert;
      const data = matches(filter, updated)
        ? page.data.map((a, j) => (j === i ? updated : a))
        : page.data.filter((a) => a.id !== ev.alertId);
      qc.setQueryData(key, { ...page, data });
    }
  }
  if (ev.type === 'alert.created') {
    arrived.set(ev.alert.id, Date.now());
    if (arrived.size > 200) arrived.delete(arrived.keys().next().value!);
  }
  if (ev.type === 'alert.updated' || ev.type === 'timeline.appended') {
    void qc.invalidateQueries({ queryKey: ['alert', ev.alertId] });
  }
  if (ev.type === 'schema.discovered') void qc.invalidateQueries({ queryKey: ['schemas'] });
}

const CLOSE_UNAUTHORIZED = 4001;
const CLOSE_EXPIRED = 4002;

export function useLive(enabled: boolean): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const attempt = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let everLive = false;

    const connect = () => {
      const token = getToken();
      if (!token) return setStatus('offline');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (m) => {
        const raw = JSON.parse(String(m.data)) as { type: string };
        if (raw.type === 'ready') {
          attempt.current = 0;
          setStatus('live');
          if (everLive) void qc.invalidateQueries({ queryKey: ['alerts'] }); // catch up after a gap
          everLive = true;
          return;
        }
        const ev = UiEvent.safeParse(raw);
        if (ev.success) apply(qc, ev.data);
      };
      ws.onclose = async (e) => {
        if (stopped) return;
        setStatus(navigator.onLine ? 'reconnecting' : 'offline');
        if (e.code === CLOSE_EXPIRED || e.code === CLOSE_UNAUTHORIZED) {
          if (!(await refresh())) return setStatus('offline');
        }
        const delay = Math.min(30_000, 500 * 2 ** attempt.current++) * (0.75 + Math.random() / 2);
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    const off = onTokenChange((t) => {
      if (!t) ws?.close();
    });
    return () => {
      stopped = true;
      off();
      clearTimeout(timer);
      ws?.close();
    };
  }, [enabled, qc]);

  return status;
}
