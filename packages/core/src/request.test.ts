import { expect, spyOn, test } from 'bun:test';
import { invalidWait, waitForRequest } from './request';

test('a null timeout skips the default deadline and still observes completion', async () => {
  let complete!: (value: string) => void;
  const result = new Promise<string>(resolve => { complete = resolve; });
  const timers = spyOn(globalThis, 'setTimeout');
  let pending: Promise<string>;
  try {
    pending = waitForRequest(() => result, { timeoutMs: null }, 1);
    expect(timers).not.toHaveBeenCalled();
  } finally { timers.mockRestore(); }
  expect(invalidWait({ timeoutMs: null })).toBe(false);
  complete('done');
  expect(await pending!).toBe('done');
});

test('an unlimited wait remains abortable without cancelling its operation', async () => {
  const controller = new AbortController();
  let complete!: (value: string) => void;
  const result = new Promise<string>(resolve => { complete = resolve; });
  const pending = waitForRequest(() => result, { timeoutMs: null, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED', outcomeUnknown: true });
  complete('late completion');
  expect(await result).toBe('late completion');
});

test('an already aborted unlimited wait never dispatches and backend failures still propagate', async () => {
  const controller = new AbortController();
  controller.abort();
  let dispatched = false;
  await expect(waitForRequest(async () => { dispatched = true; }, { timeoutMs: null, signal: controller.signal }))
    .rejects.toMatchObject({ code: 'REQUEST_ABORTED', outcomeUnknown: false });
  expect(dispatched).toBe(false);
  await expect(waitForRequest(async () => { throw new Error('backend failure'); }, { timeoutMs: null }))
    .rejects.toThrow('backend failure');
});
