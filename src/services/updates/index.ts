import {
  getLibraryNovelsForGlobalUpdate,
  getLibraryWithCategory,
} from '../../database/queries/LibraryQueries';

import { showToast } from '../../utils/showToast';
import { updateNovel, type UpdateNovelOptions } from './LibraryUpdateQueries';
import {
  clearResumeCursor,
  filterSourceQueueWithPlugin,
  getResumeCursor,
  getResumeCursorKey,
  isSourceUpdatePausedError,
  rotateQueueFromCursor,
  setResumeCursor,
} from './sourceUpdateControl';
import type { DBNovelInfo } from '@database/types';
import { sleep } from '@utils/sleep';
import { MMKVStorage, getMMKVObject } from '@utils/mmkv/mmkv';
import { LAST_UPDATE_TIME } from '@hooks/persisted/useUpdates';
import dayjs from 'dayjs';
import {
  APP_SETTINGS,
  AppSettings,
  getGlobalUpdateCategoryFilters,
} from '@hooks/persisted/useSettings';
import type {
  BackgroundTask,
  BackgroundTaskEnqueuer,
  TaskProgressUpdater,
} from '@services/backgroundTasks/contracts';

const UPDATE_SOURCE_CONCURRENCY = 3;

const groupNovelsByPlugin = (novels: DBNovelInfo[]) => {
  const groupedNovels = new Map<string, DBNovelInfo[]>();

  for (const novel of novels) {
    const pluginNovels = groupedNovels.get(novel.pluginId);
    if (pluginNovels) {
      pluginNovels.push(novel);
    } else {
      groupedNovels.set(novel.pluginId, [novel]);
    }
  }

  return [...groupedNovels.values()];
};
const MAX_DOWNLOAD_CHAPTERS_PER_TASK = 100;

const enqueueDownloadTasks = (
  enqueue: BackgroundTaskEnqueuer,
  tasks: BackgroundTask | BackgroundTask[],
) => {
  for (const task of Array.isArray(tasks) ? tasks : [tasks]) {
    if (task.name !== 'DOWNLOAD_CHAPTER') {
      enqueue(task);
      continue;
    }

    const chapters = task.data.chapters.map(chapter =>
      chapter.novelId === undefined && task.data.novelId !== undefined
        ? { ...chapter, novelId: task.data.novelId }
        : chapter,
    );

    for (
      let start = 0;
      start < chapters.length;
      start += MAX_DOWNLOAD_CHAPTERS_PER_TASK
    ) {
      enqueue({
        ...task,
        data: {
          ...task.data,
          chapters: chapters.slice(
            start,
            start + MAX_DOWNLOAD_CHAPTERS_PER_TASK,
          ),
        },
      });
    }
  }
};

const updateLibrary = async (
  {
    categoryId,
  }: {
    categoryId?: number;
  },
  setMeta: TaskProgressUpdater,
  enqueue: BackgroundTaskEnqueuer,
) => {
  setMeta(meta => ({
    ...meta,
    isRunning: true,
    progress: 0,
  }));

  const {
    downloadNewChapters,
    refreshNovelMetadata,
    smartUpdateSkipCompleted,
    smartUpdateSkipUnstarted,
    smartUpdateSkipWithUnread,
  } = getMMKVObject<AppSettings>(APP_SETTINGS) || {};
  const smartUpdateFilters = {
    skipCompleted: Boolean(smartUpdateSkipCompleted),
    skipUnstarted: Boolean(smartUpdateSkipUnstarted),
    skipWithUnread: Boolean(smartUpdateSkipWithUnread),
  };
  const options: UpdateNovelOptions = {
    downloadNewChapters: downloadNewChapters || false,
    refreshNovelMetadata: refreshNovelMetadata || false,
    isBackground: true,
    enqueue: tasks => enqueueDownloadTasks(enqueue, tasks),
  };

  try {
    let libraryNovels: DBNovelInfo[] = [];
    if (categoryId) {
      libraryNovels = await getLibraryWithCategory(categoryId, true);
    } else {
      libraryNovels = await getLibraryNovelsForGlobalUpdate(
        getGlobalUpdateCategoryFilters(),
        smartUpdateFilters,
      );
    }

    if (libraryNovels.length > 0) {
      MMKVStorage.set(LAST_UPDATE_TIME, dayjs().format('YYYY-MM-DD HH:mm:ss'));

      const sourceQueues = groupNovelsByPlugin(libraryNovels);
      const activeNovels = new Map<string, string>();
      let completedNovels = 0;
      let nextSourceQueue = 0;

      const publishProgress = () => {
        setMeta(meta => ({
          ...meta,
          progressText: [...activeNovels.values()].join('\n') || undefined,
          progress: completedNovels / libraryNovels.length,
        }));
      };

      const updateSourceQueue = async (sourceQueue: DBNovelInfo[]) => {
        if (!sourceQueue.length) {
          return;
        }
        const pluginId = sourceQueue[0].pluginId;
        const cursorKey = getResumeCursorKey(pluginId, categoryId);

        let queue = sourceQueue;
        let filteredByPlugin = false;
        try {
          const filtered = await filterSourceQueueWithPlugin(
            pluginId,
            sourceQueue,
            statusText => {
              activeNovels.set(pluginId, statusText);
              publishProgress();
            },
          );
          activeNovels.delete(pluginId);
          queue = filtered.queue;
          filteredByPlugin = filtered.filteredByPlugin;
          if (filtered.skippedCount > 0) {
            completedNovels += filtered.skippedCount;
            publishProgress();
          }
        } catch (error: unknown) {
          activeNovels.delete(pluginId);
          if (isSourceUpdatePausedError(error)) {
            showToast(error instanceof Error ? error.message : String(error));
            completedNovels += sourceQueue.length;
            publishProgress();
            return;
          }
          throw error;
        }

        if (!filteredByPlugin) {
          queue = rotateQueueFromCursor(queue, getResumeCursor(cursorKey));
        }

        let paused = false;
        for (let index = 0; index < queue.length; index++) {
          const novel = queue[index];
          activeNovels.set(novel.pluginId, novel.name);
          publishProgress();

          try {
            await updateNovel(novel.pluginId, novel.path, novel.id, options);
            await sleep(1000);
          } catch (error: unknown) {
            if (isSourceUpdatePausedError(error)) {
              paused = true;
              if (!filteredByPlugin) {
                setResumeCursor(cursorKey, novel.path);
              }
              showToast(error instanceof Error ? error.message : String(error));
            } else {
              showToast(
                novel.name +
                  ': ' +
                  (error instanceof Error ? error.message : String(error)),
              );
            }
          } finally {
            completedNovels += paused ? queue.length - index : 1;
            activeNovels.delete(novel.pluginId);
            publishProgress();
          }

          if (paused) {
            break;
          }
        }

        if (!paused && !filteredByPlugin) {
          clearResumeCursor(cursorKey);
        }
      };

      const updateNextSource = async () => {
        while (nextSourceQueue < sourceQueues.length) {
          const sourceQueue = sourceQueues[nextSourceQueue];
          nextSourceQueue += 1;
          await updateSourceQueue(sourceQueue);
        }
      };

      const sourceResults = await Promise.allSettled(
        Array.from(
          {
            length: Math.min(UPDATE_SOURCE_CONCURRENCY, sourceQueues.length),
          },
          updateNextSource,
        ),
      );
      const rejectedSource = sourceResults.find(
        result => result.status === 'rejected',
      );
      if (rejectedSource?.status === 'rejected') {
        throw rejectedSource.reason;
      }
    } else {
      showToast("There's no novel to be updated");
    }
  } finally {
    setMeta(meta => ({
      ...meta,
      progress: 1,
      progressText: undefined,
      isRunning: false,
    }));
  }
};

export { updateLibrary };
