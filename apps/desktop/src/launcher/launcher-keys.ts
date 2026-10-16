// Keyboard movement inside one launcher column: the agent list, or the Resume column (search,
// rows, Show more). Tab between the columns is the browser's, because each column keeps one
// tabbable item; this only moves within a column.

/** The item a key moves to from `index`, skipping disabled items and stopping at either end; null when the key does not move. */
export function columnStep(
  index: number,
  key: string,
  disabled: readonly boolean[],
): number | null {
  const open = (at: number) =>
    at >= 0 && at < disabled.length && disabled[at] !== true;
  const scan = (from: number, by: 1 | -1) => {
    for (let at = from; at >= 0 && at < disabled.length; at += by)
      if (open(at)) return at;
    return null;
  };
  const next = (() => {
    switch (key) {
      case "ArrowDown":
        return scan(index + 1, 1);
      case "ArrowUp":
        return scan(index - 1, -1);
      case "Home":
        return scan(0, 1);
      case "End":
        return scan(disabled.length - 1, -1);
      default:
        return null;
    }
  })();
  return next === index ? null : next;
}

/**
 * Moves the focus within the column that holds the key's target, through its `data-column-item`
 * elements in order; returns the element focused, or null when the key was left alone. Home and End
 * stay with a text box, which moves its caret with them.
 */
export function moveInColumn(event: {
  key: string;
  target: EventTarget;
  currentTarget: HTMLElement;
  preventDefault: () => void;
}): HTMLElement | null {
  if (!(event.target instanceof HTMLElement)) return null;
  if (
    event.target instanceof HTMLInputElement &&
    (event.key === "Home" || event.key === "End")
  )
    return null;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>("[data-column-item]"),
  ];
  const index = items.indexOf(event.target);
  if (index === -1) return null;
  const next = columnStep(
    index,
    event.key,
    items.map((item) => item.matches(":disabled")),
  );
  if (next === null) return null;
  event.preventDefault();
  const item = items[next];
  item?.focus();
  return item ?? null;
}
