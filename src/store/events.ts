/**
 * Global app state.
 *
 * The raw event data lives in the data worker; the store only keeps
 * metadata, filter-dimension values, the latest filter aggregates
 * (counts + dashboard data + the sorted match index), and the currently
 * selected event's detail. Every filter change runs as a query against
 * the worker; responses carry the queryId so stale ones are discarded.
 */
import { create } from 'zustand';
import { emptyFilters, defaultSort, type Filters, type SortKey } from '../parser/filtering';
import { EMPTY_AGGREGATES, type Aggregates } from '../parser/aggregate';
import { requestFilter, getEventDetail } from '../workers/client';
import type { Dimensions, EventDetailData, FileMeta } from '../workers/protocol';

export { emptyFilters, compileSearch, filterEvents } from '../parser/filtering';
export type { Filters, SortKey } from '../parser/filtering';
export type { FileMeta } from '../workers/protocol';

export interface AppState {
  files: FileMeta[];
  eventCount: number;
  dimensions: Dimensions;
  matchCount: number;
  aggregates: Aggregates;
  filtering: boolean;

  loading: boolean;
  progress: { fileName: string; processed: number; total: number } | null;
  error: string | null;

  selectedEventIndex: number | null;
  selectedDetail: EventDetailData | null;

  filters: Filters;
  sort: SortKey;

  setData: (files: FileMeta[], eventCount: number, dimensions: Dimensions) => void;
  setLoading: (loading: boolean, progress?: AppState['progress']) => void;
  setError: (error: string | null) => void;
  setProgress: (progress: AppState['progress']) => void;
  selectEvent: (index: number | null) => void;
  setFilters: (patch: Partial<Filters>) => void;
  resetFilters: () => void;
  setSort: (sort: SortKey) => void;
}

let queryId = 0;

export const useStore = create<AppState>((set, get) => {
  const applyQuery = () => {
    const qid = ++queryId;
    const { filters, sort } = get();
    set({ filtering: true });
    requestFilter(qid, filters, sort).then((aggregates) => {
      if (qid !== queryId) return; // a newer query superseded this one
      set({ aggregates, matchCount: aggregates.matchCount, filtering: false });
    });
  };

  return {
    files: [],
    eventCount: 0,
    dimensions: { types: [], namespaces: [], pods: [], nodes: [] },
    matchCount: 0,
    aggregates: EMPTY_AGGREGATES,
    filtering: false,

    loading: false,
    progress: null,
    error: null,

    selectedEventIndex: null,
    selectedDetail: null,

    filters: emptyFilters,
    sort: defaultSort,

    setData: (files, eventCount, dimensions) => {
      set({
        files,
        eventCount,
        dimensions,
        loading: false,
        progress: null,
        error: null,
        selectedEventIndex: null,
        selectedDetail: null,
      });
      applyQuery();
    },

    setLoading: (loading, progress = null) => set({ loading, progress, error: null }),
    setError: (error) => set({ error, loading: false, progress: null }),
    setProgress: (progress) => set({ progress }),

    selectEvent: (index) => {
      set({ selectedEventIndex: index });
      if (index === null) {
        set({ selectedDetail: null });
        return;
      }
      getEventDetail(index).then((detail) => {
        if (get().selectedEventIndex !== index) return; // selection moved on
        set({ selectedDetail: detail });
      });
    },

    setFilters: (patch) => {
      set((s) => ({ filters: { ...s.filters, ...patch } }));
      applyQuery();
    },

    resetFilters: () => {
      set({ filters: emptyFilters });
      applyQuery();
    },

    setSort: (sort) => {
      set({ sort });
      applyQuery();
    },
  };
});
