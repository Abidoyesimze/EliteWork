import { act } from '@testing-library/react-native';

import {
  useAdminActionHistoryStore,
  AdminActionRecord,
} from './adminActionHistoryStore';

function resetStore(): void {
  act(() => {
    useAdminActionHistoryStore.getState().clearHistory();
  });
}

function createRecord(index: number): AdminActionRecord {
  return {
    actionType: 'Lock',
    streamId: `stream-${index}`,
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
  };
}

describe('useAdminActionHistoryStore', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('initial state and selectors', () => {
    it('initializes with an empty history array', () => {
      const state = useAdminActionHistoryStore.getState();
      expect(state.history).toEqual([]);
    });

    it('reflects added records via getState().history', () => {
      const record: AdminActionRecord = {
        actionType: 'Clawback',
        streamId: 'stream-abc',
        timestamp: '2026-01-01T10:00:00.000Z',
      };

      act(() => {
        useAdminActionHistoryStore.getState().addAction(record);
      });

      const { history } = useAdminActionHistoryStore.getState();
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(record);
    });

    it('exposes addAction and clearHistory as functions', () => {
      const state = useAdminActionHistoryStore.getState();
      expect(typeof state.addAction).toBe('function');
      expect(typeof state.clearHistory).toBe('function');
    });
  });

  describe('addAction', () => {
    it('prepends a single record to history', () => {
      const record: AdminActionRecord = {
        actionType: 'Lock',
        streamId: 'stream-1',
        timestamp: '2026-01-01T00:00:00.000Z',
      };

      act(() => {
        useAdminActionHistoryStore.getState().addAction(record);
      });

      const { history } = useAdminActionHistoryStore.getState();
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(record);
    });

    it('orders records newest-first (prepends each new action)', () => {
      const record1: AdminActionRecord = {
        actionType: 'Lock',
        streamId: 'stream-1',
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      const record2: AdminActionRecord = {
        actionType: 'Clawback',
        streamId: 'stream-2',
        timestamp: '2026-01-01T00:01:00.000Z',
      };
      const record3: AdminActionRecord = {
        actionType: 'Terminate',
        streamId: 'stream-3',
        timestamp: '2026-01-01T00:02:00.000Z',
      };

      act(() => {
        useAdminActionHistoryStore.getState().addAction(record1);
        useAdminActionHistoryStore.getState().addAction(record2);
        useAdminActionHistoryStore.getState().addAction(record3);
      });

      const { history } = useAdminActionHistoryStore.getState();
      expect(history).toHaveLength(3);
      expect(history[0]).toEqual(record3);
      expect(history[1]).toEqual(record2);
      expect(history[2]).toEqual(record1);
    });

    it('caps history at MAX_HISTORY (50) entries and drops oldest records', () => {
      act(() => {
        for (let i = 1; i <= 60; i++) {
          useAdminActionHistoryStore.getState().addAction(createRecord(i));
        }
      });

      const { history } = useAdminActionHistoryStore.getState();
      expect(history).toHaveLength(50);
      // Newest item added was stream-60
      expect(history[0].streamId).toBe('stream-60');
      // 50th item should be stream-11 (streams 1 through 10 dropped)
      expect(history[49].streamId).toBe('stream-11');
    });

    it('creates a new array reference on each addAction', () => {
      const historyBefore = useAdminActionHistoryStore.getState().history;

      act(() => {
        useAdminActionHistoryStore.getState().addAction(createRecord(1));
      });

      const historyAfter = useAdminActionHistoryStore.getState().history;
      expect(historyAfter).not.toBe(historyBefore);
    });
  });

  describe('clearHistory', () => {
    it('resets history to an empty array', () => {
      act(() => {
        useAdminActionHistoryStore.getState().addAction(createRecord(1));
        useAdminActionHistoryStore.getState().addAction(createRecord(2));
      });
      expect(useAdminActionHistoryStore.getState().history).toHaveLength(2);

      act(() => {
        useAdminActionHistoryStore.getState().clearHistory();
      });

      expect(useAdminActionHistoryStore.getState().history).toEqual([]);
    });

    it('safely handles clearHistory when history is already empty', () => {
      expect(useAdminActionHistoryStore.getState().history).toEqual([]);

      act(() => {
        useAdminActionHistoryStore.getState().clearHistory();
      });

      expect(useAdminActionHistoryStore.getState().history).toEqual([]);
    });
  });
});
