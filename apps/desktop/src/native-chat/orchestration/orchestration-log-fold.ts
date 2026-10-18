// Whether the orchestration's session log is folded to its one-line bar, as this viewer last left
// it. Folded is the default: the board is what the view is for, and the bar still shows the latest.

export const logFoldKey = 'megabrain.orchestration.log-folded'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** What this viewer's storage kept; anything but an explicit "open" is folded. */
export function readLogFolded(storage: Store): boolean {
  try {
    return storage.getItem(logFoldKey) !== 'false'
  } catch {
    return true
  }
}

export function writeLogFolded(storage: Store, folded: boolean): void {
  try {
    storage.setItem(logFoldKey, folded ? 'true' : 'false')
  } catch {
    // Storage refused (a private window): the log still folds for this view, only not remembered.
  }
}
