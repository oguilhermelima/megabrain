import { oneTokenEach, tokenLabels, type Draft } from '@/chat/composer-parts'

// The bridge between a Draft and the contenteditable box that shows it. The box holds text nodes
// and one non-editable span per token; offsets count a character of text or a token as one, the
// same as composer-parts. The browser edits text in place and readDraft takes the result back;
// every other change renders the whole draft and puts the caret back.

export interface TokenView {
  kind: 'image' | 'pdf'
  name: string
}

// A zero-width space after a token that has no text after it, so the caret can stand there: WebKit
// will not place it after a non-editable element at the end of a line. It is never part of the draft.
const spacer = '​'

const visible = (text: string) => text.replaceAll(spacer, '')

function tokenOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  for (let current = node; current !== null && current !== root; current = current.parentNode) {
    if (current instanceof HTMLElement && current.dataset.token !== undefined) return current
  }
  return null
}

/** The token a pointer event happened on, if any. */
export function tokenAt(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  return target instanceof Node ? tokenOf(target, root) : null
}

/** A chip's shell, the height of a line; a sent message shows its images in the same chip. */
export const chipClass = 'mx-0.5 inline-flex h-[22px] items-center gap-0.5 rounded-md border border-white/[0.12] bg-white/[0.08] align-middle text-[12.5px] leading-none text-ink-200 select-none hover:border-white/25 hover:bg-white/[0.12]'

/**
 * A token as a chip the height of a line: its label and a remove button. It is not draggable: the
 * composer moves it with pointer events, since a native drag in the app's webview leaves the page.
 */
function tokenElement(id: string, view: TokenView, label: string): HTMLElement {
  const token = document.createElement('span')
  token.dataset.token = id
  token.contentEditable = 'false'
  token.draggable = false
  token.title = view.name
  token.className = `${chipClass} cursor-grab pr-0.5 pl-1.5 data-[dragging]:opacity-40`
  const text = document.createElement('span')
  text.dataset.label = ''
  text.textContent = label
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.dataset.remove = ''
  remove.tabIndex = -1
  remove.ariaLabel = `Remove ${label}`
  remove.textContent = '×'
  remove.className = 'grid size-4 cursor-pointer place-items-center rounded text-[13px] leading-none text-ink-400 hover:bg-white/[0.12] hover:text-ink-100'
  token.append(text, remove)
  return token
}

export function renderDraft(root: HTMLElement, draft: Draft, view: (id: string) => TokenView): void {
  const labels = tokenLabels(draft, (id) => view(id).kind)
  const nodes: Node[] = []
  draft.forEach((part, index) => {
    if (part.type === 'text') {
      nodes.push(document.createTextNode(part.text))
      return
    }
    nodes.push(tokenElement(part.id, view(part.id), labels.get(part.id) ?? ''))
    if (draft[index + 1]?.type !== 'text') nodes.push(document.createTextNode(spacer))
  })
  // A line break at the very end shows only when something follows it.
  const last = draft.at(-1)
  if (last?.type === 'text' && last.text.endsWith('\n')) nodes.push(document.createElement('br'))
  root.replaceChildren(...nodes)
}

/** Brings the chips' labels in line with their order after the browser edited the box in place. */
export function relabel(root: HTMLElement, draft: Draft, kindOf: (id: string) => 'image' | 'pdf'): void {
  const labels = tokenLabels(draft, kindOf)
  root.querySelectorAll<HTMLElement>('[data-token]').forEach((token) => {
    const label = labels.get(token.dataset.token ?? '')
    const text = token.querySelector<HTMLElement>('[data-label]')
    if (label === undefined || text === null || text.textContent === label) return
    text.textContent = label
    token.querySelector('[data-remove]')?.setAttribute('aria-label', `Remove ${label}`)
  })
}

/**
 * Walks the box in document order the way readDraft counts it, returning the total. `onNode` sees
 * every node and `onText` every text node, each with the count before it; returning true ends the walk.
 */
function walk(root: HTMLElement, onText: (node: Text, count: number) => boolean, onNode: (node: Node, count: number) => boolean): number {
  let count = 0
  let done = false
  const visit = (node: Node, isLast: boolean) => {
    if (done) return
    if (onNode(node, count)) {
      done = true
      return
    }
    if (node instanceof Text) {
      if (onText(node, count)) {
        done = true
        return
      }
      count += visible(node.data).length
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.token !== undefined) {
      count += 1
      return
    }
    if (node.tagName === 'BR') {
      if (!isLast) count += 1
      return
    }
    // A block the browser made for a new line starts a line of its own.
    if ((node.tagName === 'DIV' || node.tagName === 'P') && count > 0) count += 1
    visitChildren(node, isLast)
  }
  const visitChildren = (node: Node, isLast: boolean) => {
    const children = Array.from(node.childNodes)
    children.forEach((child, index) => visit(child, isLast && index === children.length - 1))
  }
  visitChildren(root, true)
  return count
}

export function readDraft(root: HTMLElement): Draft {
  const draft: Draft = []
  const pushText = (text: string) => {
    if (text === '') return
    const last = draft.at(-1)
    if (last?.type === 'text') draft[draft.length - 1] = { type: 'text', text: last.text + text }
    else draft.push({ type: 'text', text })
  }
  const visit = (node: Node, isLast: boolean) => {
    if (node instanceof Text) {
      pushText(visible(node.data))
      return
    }
    if (!(node instanceof HTMLElement)) return
    const id = node.dataset.token
    if (id !== undefined) {
      draft.push({ type: 'token', id })
      return
    }
    if (node.tagName === 'BR') {
      if (!isLast) pushText('\n')
      return
    }
    if ((node.tagName === 'DIV' || node.tagName === 'P') && draft.length > 0) pushText('\n')
    const children = Array.from(node.childNodes)
    children.forEach((child, index) => visit(child, isLast && index === children.length - 1))
  }
  const children = Array.from(root.childNodes)
  children.forEach((child, index) => visit(child, index === children.length - 1))
  return oneTokenEach(draft)
}

/** The node a position between children sits before, or null at the very end of the box. */
function nodeAfter(root: HTMLElement, target: Node, targetOffset: number): Node | null {
  const child = target.childNodes[targetOffset]
  if (child !== undefined) return child
  for (let current: Node | null = target; current !== null && current !== root; current = current.parentNode) {
    if (current.nextSibling !== null) return current.nextSibling
  }
  return null
}

/** The draft offset of a DOM position inside the box; a position inside a token is the token's start. */
export function offsetOf(root: HTMLElement, target: Node, targetOffset: number): number {
  const before = target instanceof Text ? null : nodeAfter(root, target, targetOffset)
  let result: number | null = null
  const end = walk(
    root,
    (node, count) => {
      if (node !== target) return false
      result = count + visible(node.data.slice(0, targetOffset)).length
      return true
    },
    (node, count) => {
      const isToken = node instanceof HTMLElement && node.dataset.token !== undefined
      if (node === before || (isToken && node.contains(target))) {
        result = count
        return true
      }
      return false
    },
  )
  return result ?? end
}

/** The selection inside the box as draft offsets, or null when it is elsewhere. */
export function selectionOffsets(root: HTMLElement): [number, number] | null {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = offsetOf(root, range.startContainer, range.startOffset)
  const end = offsetOf(root, range.endContainer, range.endOffset)
  return start <= end ? [start, end] : [end, start]
}

/** The raw index in a text node of a draft offset into its visible text. */
function rawIndex(text: string, offset: number): number {
  let seen = 0
  for (let index = 0; index < text.length; index += 1) {
    if (seen === offset) return index
    if (text[index] !== spacer) seen += 1
  }
  return text.length
}

/** A collapsed range at a draft offset, in a box renderDraft just drew. */
function rangeAt(root: HTMLElement, offset: number): Range {
  const range = document.createRange()
  let remaining = offset
  for (const child of Array.from(root.childNodes)) {
    if (child instanceof Text) {
      const length = visible(child.data).length
      if (remaining <= length) {
        // In a spacer the caret goes after the zero-width space, so it shows after the token.
        range.setStart(child, length === 0 ? child.data.length : rawIndex(child.data, remaining))
        range.collapse(true)
        return range
      }
      remaining -= length
    } else if (child instanceof HTMLElement && child.dataset.token !== undefined) {
      if (remaining === 0) {
        range.setStartBefore(child)
        range.collapse(true)
        return range
      }
      remaining -= 1
    }
  }
  range.selectNodeContents(root)
  range.collapse(false)
  return range
}

export function setCaret(root: HTMLElement, offset: number): void {
  const selection = window.getSelection()
  if (selection === null) return
  selection.removeAllRanges()
  selection.addRange(rangeAt(root, offset))
}

/** Where the caret for a drop at this offset is drawn, in viewport coordinates. */
export function caretRect(root: HTMLElement, offset: number): { left: number; top: number; height: number } | null {
  const range = rangeAt(root, offset)
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
  if (rect.height > 0) return { left: rect.left, top: rect.top, height: rect.height }
  // A collapsed range at an element boundary has no box: use the neighbouring token's edge.
  const container = range.startContainer
  const next = container === root ? root.childNodes[range.startOffset] : container.nextSibling
  const previous = container === root ? root.childNodes[range.startOffset - 1] : container
  if (next instanceof HTMLElement) {
    const box = next.getBoundingClientRect()
    return { left: box.left, top: box.top, height: box.height }
  }
  if (previous instanceof HTMLElement) {
    const box = previous.getBoundingClientRect()
    return { left: box.right, top: box.top, height: box.height }
  }
  return null
}

type PointDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
}

/** The draft offset under a point in the viewport, or null when the point is outside the box. */
export function offsetAtPoint(root: HTMLElement, x: number, y: number): number | null {
  const bounds = root.getBoundingClientRect()
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null
  // Over a token, the side of its middle decides.
  const token = tokenOf(document.elementFromPoint(x, y), root)
  if (token !== null) {
    const box = token.getBoundingClientRect()
    const start = offsetOf(root, token, 0)
    return x < box.left + box.width / 2 ? start : start + 1
  }
  const scope = document as PointDocument
  const range = scope.caretRangeFromPoint?.(x, y)
  if (range !== null && range !== undefined && root.contains(range.startContainer)) return offsetOf(root, range.startContainer, range.startOffset)
  const position = scope.caretPositionFromPoint?.(x, y)
  if (position !== null && position !== undefined && root.contains(position.offsetNode)) return offsetOf(root, position.offsetNode, position.offset)
  return walk(root, () => false, () => false)
}
