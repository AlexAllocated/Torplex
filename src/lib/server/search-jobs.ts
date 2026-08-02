const jobs = new Map<string, AbortController>();
const validSearchId = /^[a-zA-Z0-9_-]{12,100}$/;

export function startSearchJob(searchId: string) {
  if (!validSearchId.test(searchId)) throw new Error("Search job ID is invalid");
  if (jobs.has(searchId)) throw new Error("Search job is already running");
  const controller = new AbortController();
  jobs.set(searchId, controller);
  return controller;
}

export function finishSearchJob(searchId: string, controller: AbortController) {
  if (jobs.get(searchId) === controller) jobs.delete(searchId);
}

export function cancelSearchJob(searchId: string) {
  if (!validSearchId.test(searchId)) return false;
  const controller = jobs.get(searchId);
  if (!controller) return false;
  controller.abort();
  jobs.delete(searchId);
  return true;
}
