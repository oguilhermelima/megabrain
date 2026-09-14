export type StateEnvironment = Readonly<{
  readonly MEGABRAIN_STATE_DIR?: string;
  readonly HOME?: string;
}>;

export function resolveStateDirectory(environment: StateEnvironment): string {
  return environment.MEGABRAIN_STATE_DIR ?? `${environment.HOME ?? ""}/.megabrain`;
}
