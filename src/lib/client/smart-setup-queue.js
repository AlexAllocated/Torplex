const waiting = [];
let active = 0;
const limit = 2;

function drain() {
  while (active < limit && waiting.length) {
    const job = waiting.shift();
    active += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        drain();
      });
  }
}

export function withSmartSetupSlot(task) {
  return new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    drain();
  });
}
