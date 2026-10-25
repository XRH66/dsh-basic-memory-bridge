/** Serialize every bridge mutation in this process. */
let mutationChain = Promise.resolve();

export function withCommitLock(task) {
  const run = mutationChain.then(task, task);
  let guarded;
  guarded = run.catch(() => {}).finally(() => {
    if (mutationChain === guarded) mutationChain = Promise.resolve();
  });
  mutationChain = guarded;
  return run;
}
