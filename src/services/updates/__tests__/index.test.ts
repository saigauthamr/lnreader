import {
  getLibraryNovelsForGlobalUpdate,
  getLibraryWithCategory,
} from '@database/queries/LibraryQueries';
import type { BackgroundTaskMetadata } from '@services/backgroundTasks/contracts';
import { getPlugin } from '@plugins/pluginManager';
import { getMMKVObject, setMMKVObject } from '@utils/mmkv/mmkv';
import { sleep } from '@utils/sleep';
import { updateNovel } from '../LibraryUpdateQueries';
import { showToast } from '@utils/showToast';
import { updateLibrary } from '../index';

jest.mock('@database/queries/LibraryQueries', () => ({
  getLibraryNovelsForGlobalUpdate: jest.fn(),
  getLibraryWithCategory: jest.fn(),
}));
jest.mock('../LibraryUpdateQueries', () => ({
  updateNovel: jest.fn(),
}));
jest.mock('@utils/sleep', () => ({
  sleep: jest.fn(() => Promise.resolve()),
}));
jest.mock('@utils/showToast', () => ({
  showToast: jest.fn(),
}));
jest.mock('@plugins/pluginManager', () => ({
  getPlugin: jest.fn(),
}));
jest.mock('@utils/mmkv/mmkv', () => ({
  MMKVStorage: { set: jest.fn() },
  getMMKVObject: jest.fn(() => ({})),
  setMMKVObject: jest.fn(),
}));
jest.mock('@hooks/persisted/useUpdates', () => ({
  LAST_UPDATE_TIME: 'LAST_UPDATE_TIME',
}));
jest.mock('@hooks/persisted/useSettings', () => ({
  APP_SETTINGS: 'APP_SETTINGS',
  getGlobalUpdateCategoryFilters: jest.fn(() => ({
    excludedCategoryIds: [],
    includedCategoryIds: [],
  })),
}));

const mockedGetLibraryNovels = jest.mocked(getLibraryNovelsForGlobalUpdate);
const mockedGetLibraryWithCategory = jest.mocked(getLibraryWithCategory);
const mockedUpdateNovel = jest.mocked(updateNovel);
const mockedShowToast = jest.mocked(showToast);
const mockedGetMMKVObject = jest.mocked(getMMKVObject);
const mockedSetMMKVObject = jest.mocked(setMMKVObject);
const mockedGetPlugin = jest.mocked(getPlugin);
const mockedSleep = jest.mocked(sleep);

type LibraryNovel = Awaited<
  ReturnType<typeof getLibraryNovelsForGlobalUpdate>
>[number];

const novel = (id: number, pluginId: string, name: string): LibraryNovel =>
  ({
    id,
    pluginId,
    name,
    path: `/${name}`,
  } as LibraryNovel);

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

describe('updateLibrary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetMMKVObject.mockReturnValue({});
    mockedGetPlugin.mockReturnValue(undefined);
  });

  it('updates at most three different sources while keeping each source sequential', async () => {
    const novels = [
      novel(1, 'source-a', 'A One'),
      novel(2, 'source-a', 'A Two'),
      novel(3, 'source-b', 'B One'),
      novel(4, 'source-c', 'C One'),
      novel(5, 'source-d', 'D One'),
    ];
    mockedGetLibraryNovels.mockResolvedValue(novels);

    const completions = new Map<number, () => void>();
    mockedUpdateNovel.mockImplementation(
      (_pluginId, _path, novelId) =>
        new Promise<void>(resolve => completions.set(novelId, resolve)),
    );

    let metadata: BackgroundTaskMetadata = {
      name: 'Update library',
      isRunning: false,
      progress: undefined,
      progressText: undefined,
    };
    const progressSnapshots: BackgroundTaskMetadata[] = [];
    const setMeta = (
      transform: (meta: BackgroundTaskMetadata) => BackgroundTaskMetadata,
    ) => {
      metadata = transform(metadata);
      progressSnapshots.push(metadata);
    };

    const updatePromise = updateLibrary({}, setMeta, jest.fn());
    await flushPromises();

    expect(mockedUpdateNovel.mock.calls.map(([pluginId]) => pluginId)).toEqual([
      'source-a',
      'source-b',
      'source-c',
    ]);
    expect(progressSnapshots.at(-1)?.progressText).toBe(
      ['A One', 'B One', 'C One'].join('\n'),
    );

    completions.get(3)?.();
    await flushPromises();
    expect(mockedUpdateNovel).toHaveBeenCalledTimes(4);
    expect(mockedUpdateNovel.mock.calls[3][0]).toBe('source-d');

    completions.get(1)?.();
    await flushPromises();
    expect(mockedUpdateNovel).toHaveBeenCalledTimes(5);
    expect(mockedUpdateNovel.mock.calls[4][0]).toBe('source-a');

    completions.get(2)?.();
    completions.get(4)?.();
    completions.get(5)?.();
    await updatePromise;

    expect(metadata).toMatchObject({
      isRunning: false,
      progress: 1,
      progressText: undefined,
    });
  });

  it('uses the category query when an update is category-scoped', async () => {
    mockedGetLibraryWithCategory.mockResolvedValue([]);

    await updateLibrary({ categoryId: 4 }, jest.fn(), jest.fn());

    expect(mockedGetLibraryWithCategory).toHaveBeenCalledWith(4, true);
    expect(mockedGetLibraryNovels).not.toHaveBeenCalled();
  });

  it('passes smart update preferences to the global update query', async () => {
    mockedGetMMKVObject.mockReturnValue({
      smartUpdateSkipCompleted: true,
      smartUpdateSkipUnstarted: true,
      smartUpdateSkipWithUnread: true,
    });
    mockedGetLibraryNovels.mockResolvedValue([]);

    await updateLibrary({}, jest.fn(), jest.fn());

    expect(mockedGetLibraryNovels).toHaveBeenCalledWith(
      {
        excludedCategoryIds: [],
        includedCategoryIds: [],
      },
      {
        skipCompleted: true,
        skipUnstarted: true,
        skipWithUnread: true,
      },
    );
  });
  it('chunks each download task immediately without changing its identity', async () => {
    mockedGetMMKVObject.mockReturnValue({ downloadNewChapters: true });
    const novelId = 7;
    const chapters = Array.from({ length: 101 }, (_, index) => ({
      chapterId: index + 1,
      chapterName: `Chapter ${index + 1}`,
      ...(index === 0 ? {} : { novelId }),
    }));
    const downloadTask = {
      name: 'DOWNLOAD_CHAPTER' as const,
      data: {
        novelName: 'Example Novel',
        novelId,
        pluginId: 'source-a',
        chapters,
      },
    };
    const secondDownloadTask = {
      name: 'DOWNLOAD_CHAPTER' as const,
      data: {
        novelName: 'Second Novel',
        novelId: 8,
        pluginId: 'source-a',
        chapters: [
          {
            chapterId: 102,
            chapterName: 'Chapter 102',
            novelId: 8,
          },
        ],
      },
    };
    const otherTask = {
      name: 'UPDATE_LIBRARY' as const,
      data: { categoryId: 4 },
    };
    mockedGetLibraryNovels.mockResolvedValue([
      novel(1, 'source-a', 'Example Novel'),
    ]);

    let resolveUpdate!: () => void;
    mockedUpdateNovel.mockImplementation(
      async (_pluginId, _path, _novelId, options) => {
        options.enqueue?.([downloadTask, secondDownloadTask, otherTask]);
        await new Promise<void>(resolve => {
          resolveUpdate = resolve;
        });
      },
    );
    const enqueue = jest.fn();

    const updatePromise = updateLibrary({}, jest.fn(), enqueue);
    await flushPromises();

    expect(enqueue).toHaveBeenCalledTimes(4);
    const enqueuedTasks = enqueue.mock.calls.map(([task]) => task);
    const normalizedChapters = chapters.map(chapter => ({
      ...chapter,
      novelId,
    }));
    expect(enqueuedTasks[0]).toEqual({
      ...downloadTask,
      data: {
        ...downloadTask.data,
        chapters: normalizedChapters.slice(0, 100),
      },
    });
    expect(enqueuedTasks[1]).toEqual({
      ...downloadTask,
      data: {
        ...downloadTask.data,
        chapters: normalizedChapters.slice(100),
      },
    });
    expect(enqueuedTasks[2]).toEqual(secondDownloadTask);
    expect(enqueuedTasks[3]).toBe(otherTask);

    resolveUpdate();
    await updatePromise;
  });

  it('waits for every source worker before finalizing after an interruption', async () => {
    mockedGetLibraryNovels.mockResolvedValue([
      novel(1, 'source-a', 'A One'),
      novel(2, 'source-b', 'B One'),
    ]);
    let resolveSecondSource!: () => void;
    const secondSource = new Promise<void>(resolve => {
      resolveSecondSource = resolve;
    });
    mockedUpdateNovel.mockImplementation((_pluginId, _path, novelId) =>
      novelId === 2 ? secondSource : Promise.resolve(),
    );

    let metadata: BackgroundTaskMetadata = {
      name: 'Update library',
      isRunning: false,
      progress: undefined,
      progressText: undefined,
    };
    let shouldInterrupt = true;
    const setMeta = (
      transform: (meta: BackgroundTaskMetadata) => BackgroundTaskMetadata,
    ) => {
      const nextMetadata = transform(metadata);
      if (shouldInterrupt && nextMetadata.progressText === 'A One') {
        shouldInterrupt = false;
        throw new Error('interrupted');
      }
      metadata = nextMetadata;
    };

    const updatePromise = updateLibrary({}, setMeta, jest.fn());
    await flushPromises();

    expect(metadata).toMatchObject({
      isRunning: true,
      progress: 0,
    });
    resolveSecondSource();
    await expect(updatePromise).rejects.toThrow('interrupted');
    expect(metadata).toMatchObject({
      isRunning: false,
      progress: 1,
      progressText: undefined,
    });
  });

  it('stops only the paused source queue on SourceUpdatePaused with a single toast', async () => {
    const novels = [
      novel(1, 'source-a', 'A One'),
      novel(2, 'source-a', 'A Two'),
      novel(3, 'source-a', 'A Three'),
      novel(4, 'source-b', 'B One'),
      novel(5, 'source-b', 'B Two'),
    ];
    mockedGetLibraryNovels.mockResolvedValue(novels);

    mockedUpdateNovel.mockImplementation(async (pluginId, _path, novelId) => {
      if (pluginId === 'source-a' && novelId === 1) {
        const error = new Error('Source A paused to avoid rate limits.');
        error.name = 'SourceUpdatePaused';
        throw error;
      }
    });

    let metadata: BackgroundTaskMetadata = {
      name: 'Update library',
      isRunning: false,
      progress: undefined,
      progressText: undefined,
    };
    const progressValues: (number | undefined)[] = [];
    const setMeta = (
      transform: (meta: BackgroundTaskMetadata) => BackgroundTaskMetadata,
    ) => {
      metadata = transform(metadata);
      progressValues.push(metadata.progress);
    };

    await updateLibrary({}, setMeta, jest.fn());

    expect(
      mockedUpdateNovel.mock.calls.map(([pluginId, , novelId]) => [
        pluginId,
        novelId,
      ]),
    ).toEqual([
      ['source-a', 1],
      ['source-b', 4],
      ['source-b', 5],
    ]);
    expect(mockedShowToast).toHaveBeenCalledTimes(1);
    expect(mockedShowToast).toHaveBeenCalledWith(
      'Source A paused to avoid rate limits.',
    );
    expect(metadata).toMatchObject({
      isRunning: false,
      progress: 1,
      progressText: undefined,
    });
    expect(progressValues).toContain(1);
  });

  it('uses plugin checkLibraryUpdates to skip unchanged novels with zero sleep', async () => {
    const novels = [
      novel(1, 'source-a', 'A One'),
      novel(2, 'source-a', 'A Two'),
      novel(3, 'source-a', 'A Three'),
    ];
    mockedGetLibraryNovels.mockResolvedValue(novels);

    const checkLibraryUpdates = jest.fn().mockResolvedValue(['/A Two']);
    mockedGetPlugin.mockReturnValue({
      checkLibraryUpdates,
    } as unknown as ReturnType<typeof getPlugin>);
    mockedUpdateNovel.mockResolvedValue(undefined);

    let metadata: BackgroundTaskMetadata = {
      name: 'Update library',
      isRunning: false,
      progress: undefined,
      progressText: undefined,
    };
    const setMeta = (
      transform: (meta: BackgroundTaskMetadata) => BackgroundTaskMetadata,
    ) => {
      metadata = transform(metadata);
    };

    await updateLibrary({}, setMeta, jest.fn());

    expect(checkLibraryUpdates).toHaveBeenCalledTimes(1);
    expect(checkLibraryUpdates).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ path: '/A One', name: 'A One' }),
        expect.objectContaining({ path: '/A Two', name: 'A Two' }),
        expect.objectContaining({ path: '/A Three', name: 'A Three' }),
      ]),
    );
    expect(mockedUpdateNovel).toHaveBeenCalledTimes(1);
    expect(mockedUpdateNovel).toHaveBeenCalledWith(
      'source-a',
      '/A Two',
      2,
      expect.objectContaining({ isBackground: true }),
    );
    expect(mockedSleep).toHaveBeenCalledTimes(1);
    expect(metadata).toMatchObject({
      isRunning: false,
      progress: 1,
      progressText: undefined,
    });
  });

  it('resumes from the paused novel on the next sweep and clears the cursor on completion', async () => {
    const novels = [
      novel(1, 'source-a', 'A One'),
      novel(2, 'source-a', 'A Two'),
      novel(3, 'source-a', 'A Three'),
    ];
    mockedGetLibraryNovels.mockResolvedValue(novels);

    const mmkvStore: Record<string, unknown> = {};
    mockedGetMMKVObject.mockImplementation(
      (key: string) => mmkvStore[key] as never,
    );
    mockedSetMMKVObject.mockImplementation((key: string, value: unknown) => {
      mmkvStore[key] = value;
    });

    // First sweep pauses on A Two -> cursor saved at /A Two.
    mockedUpdateNovel.mockImplementation(async (_pluginId, _path, novelId) => {
      if (novelId === 2) {
        const error = new Error('Paused after budget.');
        error.name = 'SourceUpdatePaused';
        throw error;
      }
    });

    await updateLibrary({}, jest.fn(), jest.fn());

    expect(mockedUpdateNovel.mock.calls.map(([, path]) => path)).toEqual([
      '/A One',
      '/A Two',
    ]);
    expect(mmkvStore.UPDATE_RESUME_CURSORS).toEqual({
      'source-a': '/A Two',
    });

    // Second sweep rotates to start at A Two -> A Three -> A One and clears cursor.
    mockedUpdateNovel.mockReset();
    mockedUpdateNovel.mockResolvedValue(undefined);

    await updateLibrary({}, jest.fn(), jest.fn());

    expect(mockedUpdateNovel.mock.calls.map(([, path]) => path)).toEqual([
      '/A Two',
      '/A Three',
      '/A One',
    ]);
    expect(mmkvStore.UPDATE_RESUME_CURSORS).toEqual({});
  });

  it('handles SourceUpdatePaused thrown by checkLibraryUpdates cleanly', async () => {
    const novels = [
      novel(1, 'source-a', 'A One'),
      novel(2, 'source-a', 'A Two'),
    ];
    mockedGetLibraryNovels.mockResolvedValue(novels);

    const pauseError = new Error('Source paused during batch check.');
    pauseError.name = 'SourceUpdatePaused';
    mockedGetPlugin.mockReturnValue({
      checkLibraryUpdates: jest.fn().mockRejectedValue(pauseError),
    } as unknown as ReturnType<typeof getPlugin>);

    await updateLibrary({}, jest.fn(), jest.fn());

    expect(mockedUpdateNovel).not.toHaveBeenCalled();
    expect(mockedShowToast).toHaveBeenCalledTimes(1);
    expect(mockedShowToast).toHaveBeenCalledWith(
      'Source paused during batch check.',
    );
  });
});
