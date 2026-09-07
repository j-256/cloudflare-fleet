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
