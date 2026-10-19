export function createPeriodicTestRunnerCollection(collect: () => void, interval = 500): () => void {
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError("collection interval must be a positive integer");
  let completed = 0;
  return () => {
    completed += 1;
    if (completed % interval === 0) collect();
  };
}
