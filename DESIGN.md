---
name: "Cloudflare Fleet"
description: "A readable operational workspace for reviewing fleet evidence and guarded changes"
colors:
  accent: "#59d7c4"
  blue: "#5aa9ff"
  accent-2: "#ffb454"
  danger: "#ff6b78"
  green: "#77d08f"
  purple: "#b497ff"
  pink: "#f68acb"
  bg: "#0a1118"
  panel: "#111923"
  panel-raised: "#162230"
  well: "#0d161f"
  field: "#0b131c"
  ink: "#f5f7f9"
  muted: "#96a4b4"
  line: "#2b3b4d"
  slate: "#7f95ab"
  ink-on-accent: "#07130f"
  primary-fill: "rgba(90, 169, 255, 0.17)"
  accent-fill: "rgba(89, 215, 196, 0.14)"
  danger-fill: "rgba(255, 107, 120, 0.16)"
typography:
  product-title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "clamp(25px, 2.4vw, 30px)"
    lineHeight: 1
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "26px"
    fontWeight: 650
    letterSpacing: "-0.025em"
  dialog-title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "24px"
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  item-title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "18px"
    lineHeight: 1.4
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "15px"
    lineHeight: 1.5
  body-small:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
  metadata:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.4
rounded:
  compact: "6px"
  control: "7px"
  small: "8px"
  group: "9px"
  container: "10px"
  dialog: "17px"
  pill: "99px"
spacing:
  micro: "4px"
  compact: "6px"
  small: "8px"
  control: "10px"
  medium: "12px"
  section: "16px"
  evidence: "20px"
  large: "24px"
  row-gap: "28px"
  page-gutter: "clamp(16px, 3vw, 44px)"
components:
  button-default:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  button-primary:
    backgroundColor: "{colors.primary-fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  button-accent:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  button-danger:
    backgroundColor: "{colors.danger-fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "3px 7px"
  input-field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.group}"
    padding: "11px"
  navigation-link:
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  status-chip:
    textColor: "{colors.muted}"
    typography: "{typography.metadata}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
  evidence-card:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    rounded: "{rounded.group}"
    padding: "10px"
  queue-selector:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    padding: "10px 16px"
  queue-item:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "24px 0"
---

# Design System: Cloudflare Fleet

## Overview

**Creative North Star: "The Fleet Review Workspace"**

Cloudflare Fleet uses a dark, restrained operating environment that keeps exact configuration and review decisions readable. Near-black ground, blue-gray containers, pale text, mint interaction cues, and drawn outline icons establish a continuous tool surface.

Density follows the task: short controls and compact metadata surround larger values, useful headings, and clearly separated evidence. Observation, saved intent, proposed change, and verified outcome remain distinguishable in both wording and visual emphasis. The implementation uses a local system font stack without a bundled display face or decorative imagery.

**Key Characteristics:**

- Dark tonal layers with restrained, thin borders
- Readable values supported by compact technical metadata
- Mint selection and focus cues with explicit semantic status labels
- Responsive rows, wrapping identifiers, and bounded data workspaces

## Colors

The palette combines a cool dark ground with mint interaction cues and narrowly assigned operational colors. The frontmatter is normative; names below describe their use without introducing alternate values.

### Primary

- **Mint** (`accent`): keyboard focus, selected controls, supported-change affordances, and the active queue underline
- **Operational Blue** (`blue`, `primary-fill`): reviewed alignment actions, read/session context, and comparison capabilities; the primary button is a blue tint rather than a solid mint fill

### Secondary

- **Attention Amber** (`accent-2`): incomplete reads, review qualifiers, and change-method context
- **Drift Rose** (`danger`, `danger-fill`): actionable intent mismatches, failures, and destructive confirmation controls
- **Verified Green** (`green`): evaluated alignment, successful persistence, and recorded positive states; interpret it through the adjacent label
- **Intent Violet** (`purple`): expected-state capabilities, scope relationships, and layered policy context
- **Reference Pink** (`pink`): list-backed redirect target metadata

### Neutral

- **Midnight Ground** (`bg`): the page canvas, with restrained mint and blue radial washes near the top
- **Panel** (`panel`) and **Raised Panel** (`panel-raised`): navigation, dialogs, fields, and controls
- **Evidence Well** (`well`) and **Field Ground** (`field`): nested values, editors, and comparison evidence
- **Pale Ink** (`ink`) and **Muted Ink** (`muted`): essential content and supporting context
- **Structural Line** (`line`) and **Slate** (`slate`): dividers, neutral comparison borders, and hover outlines
- **Dark Accent Ink** (`ink-on-accent`): text selection and solid selected controls

**The Observation and Intent Rule.** Observed sameness and difference do not establish correctness. Use neutral observation text and borders; reserve alignment meaning for evaluated saved intent and verified outcomes, always with explicit labels.

Observation cell labels and comparison-container borders follow this rule. Shared legacy leading/outlier badges retain green and amber styling; that inherited styling does not assign correctness to an observed value and is not a pattern to extend to new observation-only surfaces. Insertions, deletions, and changed-field marks use their literal diff meaning rather than an alignment verdict.

## Typography

**Interface Font:** Inter followed by the platform sans-serif stack recorded in the frontmatter. No font asset is loaded by `index.html`, so the installed platform face supplies the interface when Inter is unavailable.

**Technical Font:** the platform monospace stack recorded in the frontmatter. Use it for structured values, exact endpoints, compact state labels, and source-oriented metadata.

The hierarchy makes the operational heading and decision evidence easy to find without introducing a separate display treatment. Sizes are task-based rather than a fixed modular ratio.

### Hierarchy

- **Product title:** a compact responsive product heading; the phone layout uses the dialog-title size
- **Headline:** the queue section heading; it reduces to the dialog-title size on phones
- **Dialog title:** value-comparison and reviewed-change headings
- **Item title:** resource or facet identity within a queue row
- **Body:** queue observations and expectations; the adjacent status line uses the larger interface step (`16px`)
- **Body-small:** queue context, action reasons, essential matrix values, and reviewed deltas
- **Label:** readable supporting field and zone labels
- **Metadata:** compact technical badges; legacy secondary controls also use the smaller interface steps (`12px` and `13px`), which do not define the evidence-reading scale

**The Evidence Reading Rule.** Keep queue values at the body scale and reviewed deltas at the body-small scale or larger. Compact metadata is a supporting layer, not a substitute for the value an operator must assess.

## Layout

The page uses a fluid gutter from the spacing tokens. The product/session header and section navigation form compact horizontal bands; navigation is sticky. On wide screens, a padded vertical divider separates the fleet summary from the product name. At the header breakpoint (`960px`), the summary moves to its own row and drops that divider. Main content spans the available width rather than sitting inside a marketing-width container. Repeated spacing favors small control gaps, medium section gaps, and generous row separation.

Review rows align resource identity, observed/expected evidence, and actions in three columns. Evidence retains two equal columns with its own gap. At the queue breakpoint (`900px`), rows use two columns and actions move underneath. At the phone breakpoint (`620px`), rows become one column, actions wrap, and the queue selectors fit equal tracks. At the narrow breakpoint (`380px`), the first selector spans the full row and the remaining selectors share the next row; secondary summary and context content is reduced.

Configuration remains a bounded matrix with sticky structural columns. Category/facet widths are (`112px` / `248px`) on larger screens and (`96px` / `180px`) on phones. The comparison table becomes vertically stacked field/value blocks on phones, repeating the variant label for each value instead of requiring a wide comparison table. Long identifiers and values wrap within their own cells.

Standard dialogs are bounded to (`960px`) and workspace dialogs to (`1680px`), each inset from the viewport. Workspace height follows the dynamic viewport. Dialog interiors scroll within their bounds; the matrix-focus layout dedicates the available viewport to its controls and data region. Additional breakpoints in `styles.css` support specific dialog and toolbar layouts rather than a universal grid system.

**The Bounded Workspace Rule.** Let page content wrap and stack. Keep wide data inside its own scrollable matrix or comparison region, with its controls reachable outside that region.

## Elevation & Depth

Persistent queues are flat, divided by thin structural rules. Panels and evidence wells establish depth through subtle tonal differences, with no resting card shadow. Overlays use a dimmed, softly blurred backdrop; dialogs and tooltips add deep, diffuse shadows. Small status glows and inset focus or selection treatments indicate state rather than creating a decorative layer.

### Shadow Vocabulary

- **Dialog:** the diffuse modal shadow recorded in the sidecar
- **Tooltip:** the smaller floating-context shadow recorded in the sidecar
- **Guide:** a restrained local help overlay shadow recorded in the sidecar

**The Surface Before Shadow Rule.** Use tonal fills and thin borders for persistent structure. Reserve deep soft shadows and dimming for overlaid context such as dialogs and tooltips.

Motion is brief and functional: selected cell backgrounds, outlines, and collapsible affordances use the short ease transition recorded in the sidecar. Standard button hover shifts upward slightly without a shared animated transition. Reduced-motion preferences shorten transitions and animations and disable animated scrolling; retain that behavior when extending a component.

## Shapes

Controls and small evidence regions use gently rounded rectangular corners. Larger containers increase the radius modestly; dialogs have the largest recurring radius. Pills are reserved for compact state and scope metadata. Queue rows remain open horizontal bands rather than individually elevated cards. Borders are usually a single thin structural line, with colored outlines carrying explicit selection or state.

Icons use drawn SVG strokes, rounded caps and joins, and `currentColor`. Keep them inline with their label or control; do not replace them with text glyphs. The product uses text identity rather than an ornamental emblem.

## Components

### Buttons

Buttons are compact, bordered, and explicit. The default uses a raised surface; primary uses a blue tint, accent uses a mint tint, and danger uses a rose tint. Quiet buttons retain a border with transparent fill and muted text. Base and quiet padding are recorded in the frontmatter. Queue actions raise the minimum target height (`40px`), with phone and narrow layouts preserving readable wrapping.

Hover changes the border to slate and lifts the control (`1px`). Keyboard focus uses a mint outline (`2px`) offset from the edge (`2px`). Disabled controls reduce opacity and use the unavailable cursor; accompanying copy must explain a blocked action where relevant. Confirmation controls preserve the reviewed-plan acknowledgment flow.

### Chips

Compact metadata pills use a thin border, small monospace text, and explicit wording. Neutral pills describe scope or facts; semantic variants inherit the labeled intent, read, persistence, or action state. They remain supporting information rather than a value-reading surface.

### Cards / Containers

Nested evidence and editor containers use dark wells, small corner radii, and subtle borders. Value-comparison groups use a slate leading edge, including common and missing groups. Standard evidence cards have compact padding; section containers have a little more internal structure. Avoid adding persistent shadows to distinguish adjacent data groups.

### Inputs / Fields

Toolbar fields use raised surfaces, compact padding, and the control radius. Dialog fields use the darker field ground, larger padding, and group radius, with a minimum control height (`42px`) for single-line inputs. Text areas preserve structured source formatting. Focus follows the shared mint outline and text entry uses a mint caret. A field label and error message carry meaning independently of color.

### Navigation

Section links are compact bordered rectangles with mint hover and keyboard-focus text/borders. Their band stays sticky and wraps into two columns on phones. Queue selectors are a separate in-place group: a mint underline, panel fill, and explicit pressed state identify the active queue. Queue counts use tabular numerals.

### Review Evidence

A queue item keeps identity, scope, observation, expectation, and action in a stable reading order. The title is stronger than supporting scope/reason text; observed and expected values share the same readable scale. Empty states retain the evidence qualifier rather than presenting unconditional success. Pagination and secondary tools follow the list.

Reviewed-change panels preserve exact targets and before/after values in bounded, wrapping regions. Essential deltas use the body-small scale. Raw request payloads remain available through disclosure without replacing the readable comparison.

## Do's and Don'ts

### Do:

- **Do** keep observed values, expected values, and the resulting action visibly distinct.
- **Do** preserve exact identifiers and source-value access while wrapping long content within its container.
- **Do** pair status color with words or drawn icons and retain visible keyboard focus.
- **Do** use larger evidence text and heading hierarchy to make dense operational work readable.
- **Do** let rows and controls reflow before adding horizontal page scrolling.

### Don't:

- **Don't** interpret a common observed value as approved intent or verified alignment.
- **Don't** use compact metadata styles for the essential values or deltas being reviewed.
- **Don't** add introductory kickers or decorative display typography to operational sections.
- **Don't** imply that an empty queue proves alignment outside configured, successfully checked scope.
- **Don't** replace a concrete blocked or incomplete state with color-only reassurance.
