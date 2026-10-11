export type ClockTimer = unknown;

export type Clock = Readonly<{
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => ClockTimer;
  clearTimeout: (timer: ClockTimer) => void;
}>;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}
