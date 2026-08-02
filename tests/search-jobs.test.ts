import { afterEach, describe, expect, test } from 'bun:test';
import { cancelSearchJob, finishSearchJob, startSearchJob } from '../src/lib/server/search-jobs';

const controllers: Array<[string, AbortController]> = [];

afterEach(() => {
  for (const [id, controller] of controllers.splice(0)) finishSearchJob(id, controller);
});

describe('search job cancellation', () => {
  test('aborts and removes a running search job', () => {
    const id = 'search-test-cancellation';
    const controller = startSearchJob(id);
    controllers.push([id, controller]);

    expect(cancelSearchJob(id)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(cancelSearchJob(id)).toBe(false);
  });

  test('rejects malformed and duplicate IDs', () => {
    expect(() => startSearchJob('short')).toThrow('Search job ID is invalid');
    const id = 'search-test-duplicate';
    const controller = startSearchJob(id);
    controllers.push([id, controller]);
    expect(() => startSearchJob(id)).toThrow('Search job is already running');
  });
});
