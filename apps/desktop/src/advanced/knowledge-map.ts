// The Knowledge map's layout: a small force simulation, deterministic so the same topics always land
// in the same places. Every pair of nodes repels, each edge pulls its ends together (harder the more
// they share), a light pull keeps the graph centred, and a last pass pushes overlapping nodes apart
// and keeps each inside the canvas. A few dozen topics take well under a frame.

export interface LayoutNode {
  id: string
  radius: number
}

export interface LayoutEdge {
  source: string
  target: string
  /** How strongly the two are linked; 1 for one shared chat, file or ref. */
  weight: number
}

export interface Point {
  x: number
  y: number
}

const iterations = 300
/** Room left between two nodes' edges once the layout settles. */
const gap = 10

export function layoutGraph(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], size: { width: number; height: number }): Map<string, Point> {
  const { width, height } = size
  const centre = { x: width / 2, y: height / 2 }
  const index = new Map(nodes.map((node, at) => [node.id, at]))
  const links = edges.flatMap((edge) => {
    const source = index.get(edge.source)
    const target = index.get(edge.target)
    return source === undefined || target === undefined || source === target ? [] : [{ source, target, weight: edge.weight }]
  })
  // A sunflower spiral from the centre: spread out, and the same for the same nodes.
  const golden = Math.PI * (3 - Math.sqrt(5))
  const spread = Math.min(width, height) / 2.5 / Math.sqrt(Math.max(1, nodes.length))
  const at: Point[] = nodes.map((_, n) => ({ x: centre.x + spread * Math.sqrt(n) * Math.cos(n * golden), y: centre.y + spread * Math.sqrt(n) * Math.sin(n * golden) }))

  // The ideal spacing for this many nodes on this canvas.
  const k = Math.sqrt((width * height) / Math.max(1, nodes.length)) * 0.4
  const gravity = 0.02 * k
  for (let step = 0; step < iterations; step++) {
    const temperature = (Math.min(width, height) / 8) * (1 - step / iterations) + 0.5
    const move: Point[] = nodes.map(() => ({ x: 0, y: 0 }))
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const left = at[i] as Point
        const right = at[j] as Point
        const dx = left.x - right.x || 0.01 * (j - i)
        const dy = left.y - right.y || 0.01
        const distance = Math.max(1, Math.hypot(dx, dy))
        const force = (k * k) / distance
        const fx = (dx / distance) * force
        const fy = (dy / distance) * force
        ;(move[i] as Point).x += fx
        ;(move[i] as Point).y += fy
        ;(move[j] as Point).x -= fx
        ;(move[j] as Point).y -= fy
      }
    }
    for (const link of links) {
      const left = at[link.source] as Point
      const right = at[link.target] as Point
      const dx = left.x - right.x
      const dy = left.y - right.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const force = ((distance * distance) / k) * Math.min(3, 1 + Math.log(link.weight))
      const fx = (dx / distance) * force
      const fy = (dy / distance) * force
      ;(move[link.source] as Point).x -= fx
      ;(move[link.source] as Point).y -= fy
      ;(move[link.target] as Point).x += fx
      ;(move[link.target] as Point).y += fy
    }
    nodes.forEach((_, n) => {
      const point = at[n] as Point
      const shift = move[n] as Point
      shift.x += (centre.x - point.x) * gravity
      shift.y += (centre.y - point.y) * gravity
      const length = Math.max(1e-9, Math.hypot(shift.x, shift.y))
      const limited = Math.min(length, temperature)
      point.x += (shift.x / length) * limited
      point.y += (shift.y / length) * limited
    })
  }

  const clamp = (n: number) => {
    const point = at[n] as Point
    const radius = (nodes[n] as LayoutNode).radius
    point.x = Math.min(width - radius, Math.max(radius, point.x))
    point.y = Math.min(height - radius, Math.max(radius, point.y))
  }
  // Settle overlaps the forces left, staying inside the canvas.
  for (let pass = 0; pass < 50; pass++) {
    let moved = false
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const left = at[i] as Point
        const right = at[j] as Point
        const need = (nodes[i] as LayoutNode).radius + (nodes[j] as LayoutNode).radius + gap
        const dx = right.x - left.x || 0.01
        const dy = right.y - left.y
        const distance = Math.hypot(dx, dy)
        if (distance >= need) continue
        const push = (need - distance) / 2 + 0.01
        left.x -= (dx / distance) * push
        left.y -= (dy / distance) * push
        right.x += (dx / distance) * push
        right.y += (dy / distance) * push
        moved = true
      }
    }
    nodes.forEach((_, n) => clamp(n))
    if (!moved) break
  }
  if (nodes.length === 1) at[0] = { ...centre }
  return new Map(nodes.map((node, n) => [node.id, at[n] as Point]))
}
