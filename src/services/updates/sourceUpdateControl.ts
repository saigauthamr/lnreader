import type { DBNovelInfo } from '@database/types';
import { getPlugin } from '@plugins/pluginManager';
import type { LibraryUpdateCandidate } from '@plugins/types';
import { getMMKVObject, setMMKVObject } from '@utils/mmkv/mmkv';

export const UPDATE_RESUME_CURSORS_KEY = 'UPDATE_RESUME_CURSORS';

/**
 * Returns true when a plugin signals that updates for its source should pause
 * (e.g. rate-limit or anti-bot pacing). Matches by Error.name so subclasses
 * compiled to ES5 plugin bundles are recognized reliably.
 */
export const isSourceUpdatePausedError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'SourceUpdatePaused';

export const getResumeCursorKey = (
  pluginId: string,
  categoryId?: number,
): string =>
  categoryId !== undefined ? `${pluginId}:cat:${categoryId}` : pluginId;

export const getResumeCursor = (cursorKey: string): string | undefined => {
  const cursors = getMMKVObject<Record<string, string>>(
    UPDATE_RESUME_CURSORS_KEY,
  );
  const path = cursors?.[cursorKey];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
};

export const setResumeCursor = (cursorKey: string, novelPath: string): void => {
  const cursors =
    getMMKVObject<Record<string, string>>(UPDATE_RESUME_CURSORS_KEY) || {};
  setMMKVObject(UPDATE_RESUME_CURSORS_KEY, {
    ...cursors,
    [cursorKey]: novelPath,
  });
};

export const clearResumeCursor = (cursorKey: string): void => {
  const cursors = getMMKVObject<Record<string, string>>(
    UPDATE_RESUME_CURSORS_KEY,
  );
  if (!cursors || !(cursorKey in cursors)) {
    return;
  }
  const { [cursorKey]: _removed, ...rest } = cursors;
  setMMKVObject(UPDATE_RESUME_CURSORS_KEY, rest);
};

export const rotateQueueFromCursor = <T extends { path: string }>(
  queue: T[],
  cursorPath?: string,
): T[] => {
  if (!cursorPath || queue.length <= 1) {
    return queue;
  }
  const index = queue.findIndex(item => item.path === cursorPath);
  if (index <= 0) {
    return queue;
  }
  return [...queue.slice(index), ...queue.slice(0, index)];
};

export interface FilteredSourceQueue {
  queue: DBNovelInfo[];
  skippedCount: number;
  filteredByPlugin: boolean;
}

/**
 * Allows plugins that expose an optional batch delta hook (`checkLibraryUpdates`)
 * to filter a source queue down to only novels that need a live `parseNovel`
 * fetch. Returns `filteredByPlugin: false` when the hook is absent, declines
 * (`undefined`), or throws a non-pause error.
 */
export const filterSourceQueueWithPlugin = async (
  pluginId: string,
  sourceQueue: DBNovelInfo[],
  onProgress?: (statusText: string) => void,
): Promise<FilteredSourceQueue> => {
  const plugin = getPlugin(pluginId);
  if (typeof plugin?.checkLibraryUpdates !== 'function') {
    return {
      queue: sourceQueue,
      skippedCount: 0,
      filteredByPlugin: false,
    };
  }

  const candidates: LibraryUpdateCandidate[] = sourceQueue.map(novel => ({
    path: novel.path,
    name: novel.name,
    lastUpdatedAt: novel.lastUpdatedAt,
    status: novel.status,
    totalChapters: novel.totalChapters ?? undefined,
  }));

  let progressError: unknown;
  const reportProgress = onProgress
    ? (statusText: string) => {
        try {
          onProgress(statusText);
        } catch (error) {
          progressError = error;
          throw error;
        }
      }
    : undefined;

  try {
    reportProgress?.(plugin.name || pluginId);
    const pathsToUpdate = await plugin.checkLibraryUpdates(
      candidates,
      reportProgress ? { onProgress: reportProgress } : undefined,
    );
    if (!Array.isArray(pathsToUpdate)) {
      return {
        queue: sourceQueue,
        skippedCount: 0,
        filteredByPlugin: false,
      };
    }

    const allowedPaths = new Set(pathsToUpdate);
    const filteredQueue = sourceQueue.filter(novel =>
      allowedPaths.has(novel.path),
    );
    return {
      queue: filteredQueue,
      skippedCount: sourceQueue.length - filteredQueue.length,
      filteredByPlugin: true,
    };
  } catch (error: unknown) {
    if (progressError !== undefined) {
      throw progressError;
    }
    if (isSourceUpdatePausedError(error)) {
      throw error;
    }
    return {
      queue: sourceQueue,
      skippedCount: 0,
      filteredByPlugin: false,
    };
  }
};
