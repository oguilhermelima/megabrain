export type StateEnvironment = Readonly<{
  readonly MEGABRAIN_STATE_DIR?: string;
  readonly HOME?: string;
}>;

export type ChildStateEnvironment = StateEnvironment & Readonly<{ readonly MEGABRAIN_DISPATCH_STATE_DIR?: string }>;

// A child's own state: the directory its dispatch was recorded in, which a later
// MEGABRAIN_STATE_DIR export (a test's temporary directory) must never redirect.
export function resolveChildStateDirectory(environment: ChildStateEnvironment): string {
  const own = environment.MEGABRAIN_DISPATCH_STATE_DIR;
  return own !== undefined && own !== "" ? own : resolveStateDirectory(environment);
}

export function resolveStateDirectory(environment: StateEnvironment): string {
  return environment.MEGABRAIN_STATE_DIR ?? `${environment.HOME ?? ""}/.megabrain`;
}
