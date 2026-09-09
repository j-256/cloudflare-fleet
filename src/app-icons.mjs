// Small inline-SVG icon set for the dashboard. Icons are built as DOM nodes
// (no innerHTML) and styled by the `.icon` class in styles.css, so they inherit
// currentColor and stay within the page's strict CSP (no external icon source,
// no inline style). Add glyphs here as the legibility pass reaches more screens.

const SVG_NS = "http://www.w3.org/2000/svg"
const ICON_VIEWBOX = "0 0 16 16"

// Each icon is a list of child element specs ({ tag, ...attributes }). Paths use
// a 16x16 grid; strokes (not fills) are set by the .icon CSS rule.
const ICONS = Object.freeze({
  ok: [{ tag: "path", d: "M3.5 8.5 6.5 11.5 12.5 5" }],
  drift: [
    { tag: "path", d: "M8 2.5 14.5 13.5 1.5 13.5Z" },
    { tag: "path", d: "M8 6.5 8 9.5" },
    { tag: "path", d: "M8 11.4 8 11.5" },
  ],
  absent: [{ tag: "path", d: "M4 8 12 8" }],
  info: [
    { tag: "circle", cx: "8", cy: "8", r: "6" },
    { tag: "path", d: "M8 7.5 8 11" },
    { tag: "path", d: "M8 5 8 5.1" },
  ],
  add: [
    { tag: "path", d: "M8 3.5 8 12.5" },
    { tag: "path", d: "M3.5 8 12.5 8" },
  ],
  edit: [
    { tag: "path", d: "M3 13 3 10.5 10.5 3 13 5.5 5.5 13Z" },
    { tag: "path", d: "M9.5 4 12 6.5" },
  ],
  remove: [
    { tag: "path", d: "M3.5 4.5 12.5 4.5" },
    { tag: "path", d: "M6 4.5 6 3 10 3 10 4.5" },
    { tag: "path", d: "M4.5 4.5 5.5 13.5 10.5 13.5 11.5 4.5" },
  ],
  close: [
    { tag: "path", d: "M4 4 12 12" },
    { tag: "path", d: "M12 4 4 12" },
  ],
  chevron: [{ tag: "path", d: "M4 6 8 10 12 6" }],
  matrix: [
    { tag: "path", d: "M2.5 2.5 6.5 2.5 6.5 6.5 2.5 6.5Z" },
    { tag: "path", d: "M9.5 2.5 13.5 2.5 13.5 6.5 9.5 6.5Z" },
    { tag: "path", d: "M2.5 9.5 6.5 9.5 6.5 13.5 2.5 13.5Z" },
    { tag: "path", d: "M9.5 9.5 13.5 9.5 13.5 13.5 9.5 13.5Z" },
  ],
  align: [
    { tag: "circle", cx: "8", cy: "8", r: "3.5" },
    { tag: "path", d: "M8 1 8 3.5" },
    { tag: "path", d: "M8 12.5 8 15" },
    { tag: "path", d: "M1 8 3.5 8" },
    { tag: "path", d: "M12.5 8 15 8" },
  ],
  active: [
    { tag: "circle", cx: "8", cy: "8", r: "5.5" },
    { tag: "circle", cx: "8", cy: "8", r: "2" },
  ],
  ack: [
    { tag: "circle", cx: "8", cy: "8", r: "6" },
    { tag: "path", d: "M5.5 8 7 9.5 10.5 6" },
  ],
  layers: [
    { tag: "path", d: "M8 2.5 14 5.5 8 8.5 2 5.5Z" },
    { tag: "path", d: "M2 9 8 12 14 9" },
  ],
  inspect: [
    { tag: "circle", cx: "6.75", cy: "6.75", r: "4.25" },
    { tag: "path", d: "M10 10 13.5 13.5" },
  ],
  record: [
    { tag: "path", d: "M3 2.5 10 2.5 13 5.5 13 13.5 3 13.5Z" },
    { tag: "path", d: "M10 2.5 10 5.5 13 5.5" },
    { tag: "circle", cx: "8", cy: "9.5", r: "2" },
  ],
  history: [
    { tag: "circle", cx: "8", cy: "8", r: "5.5" },
    { tag: "path", d: "M8 4.5 8 8 10.5 9.5" },
  ],
  schedule: [
    { tag: "path", d: "M2.5 4.5 13.5 4.5 13.5 13.5 2.5 13.5Z" },
    { tag: "path", d: "M5 2.5 5 6" },
    { tag: "path", d: "M11 2.5 11 6" },
    { tag: "path", d: "M5 8 5.1 8" },
    { tag: "path", d: "M8 8 8.1 8" },
    { tag: "path", d: "M11 8 11.1 8" },
    { tag: "path", d: "M5 11 5.1 11" },
    { tag: "path", d: "M8 11 8.1 11" },
  ],
  undo: [
    { tag: "path", d: "M5.5 4 2.5 7 5.5 10" },
    { tag: "path", d: "M3 7 9.5 7C11.7 7 13.5 8.8 13.5 11" },
  ],
  copy: [
    { tag: "path", d: "M5.5 5.5 13.5 5.5 13.5 13.5 5.5 13.5Z" },
    { tag: "path", d: "M2.5 10.5 2.5 2.5 10.5 2.5" },
  ],
  filter: [
    { tag: "path", d: "M2.5 3 13.5 3 9.5 7.5 9.5 12.5 6.5 14 6.5 7.5Z" },
  ],
  refresh: [
    { tag: "path", d: "M13 6A5.5 5.5 0 0 0 3.5 4.5" },
    { tag: "path", d: "M3.5 4.5 3.5 1.8" },
    { tag: "path", d: "M3.5 4.5 6.2 4.5" },
    { tag: "path", d: "M3 10A5.5 5.5 0 0 0 12.5 11.5" },
    { tag: "path", d: "M12.5 11.5 12.5 14.2" },
    { tag: "path", d: "M12.5 11.5 9.8 11.5" },
  ],
})

export const ICON_NAMES = Object.freeze(Object.keys(ICONS))

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("viewBox", ICON_VIEWBOX)
  svg.setAttribute("class", "icon")
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("focusable", "false")
  for (const { tag, ...attributes } of ICONS[name] || ICONS.info) {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [key, value] of Object.entries(attributes)) {
      node.setAttribute(key, String(value))
    }
    svg.append(node)
  }
  return svg
}
