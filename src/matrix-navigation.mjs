export const MATRIX_NAVIGATION_KEY = Object.freeze({
  DOWN: "ArrowDown",
  END: "End",
  HOME: "Home",
  LEFT: "ArrowLeft",
  RIGHT: "ArrowRight",
  UP: "ArrowUp",
})

export const MATRIX_NAVIGATION_KEYS = new Set(
  Object.values(MATRIX_NAVIGATION_KEY),
)

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum)
}

export function matrixRevealScrollPosition(options) {
  const maxLeft = Math.max(0, options.scrollWidth - options.clientWidth)
  const maxTop = Math.max(0, options.scrollHeight - options.clientHeight)
  const stickyWidth = clamp(options.stickyWidth, 0, options.clientWidth)
  const headerHeight = clamp(options.headerHeight, 0, options.clientHeight)
  const horizontalAnchor = stickyWidth + ((options.clientWidth - stickyWidth) / 2)
  const verticalAnchor = headerHeight + ((options.clientHeight - headerHeight) / 2)
  const left = options.horizontal
    ? options.targetLeft + (options.targetWidth / 2) - horizontalAnchor
    : options.currentLeft
  const top = options.vertical
    ? options.targetTop + (options.targetHeight / 2) - verticalAnchor
    : options.currentTop

  return {
    left: clamp(left, 0, maxLeft),
    top: clamp(top, 0, maxTop),
  }
}

function closestVerticalAction(actions, current, direction) {
  const candidateRows = [...new Set(
    actions
      .filter((action) => direction < 0
        ? action.rowIndex < current.rowIndex
        : action.rowIndex > current.rowIndex)
      .map((action) => action.rowIndex),
  )].sort((left, right) => direction < 0 ? right - left : left - right)

  for (const rowIndex of candidateRows) {
    const candidates = actions.filter(
      (action) => action.rowIndex === rowIndex
        && action.cellIndex === current.cellIndex,
    )
    if (candidates.length > 0) {
      return candidates[Math.min(current.actionIndex, candidates.length - 1)]
    }
  }
  return null
}

export function matrixNavigationTarget(
  actions,
  currentValue,
  key,
  options = {},
) {
  const current = actions.find((action) => action.value === currentValue)
  if (!current || !MATRIX_NAVIGATION_KEYS.has(key)) return null
  const rowActions = actions.filter(
    (action) => action.rowIndex === current.rowIndex,
  )

  if (key === MATRIX_NAVIGATION_KEY.LEFT
    || key === MATRIX_NAVIGATION_KEY.RIGHT) {
    const direction = key === MATRIX_NAVIGATION_KEY.LEFT ? -1 : 1
    return rowActions[rowActions.indexOf(current) + direction]?.value || null
  }
  if (key === MATRIX_NAVIGATION_KEY.UP
    || key === MATRIX_NAVIGATION_KEY.DOWN) {
    const direction = key === MATRIX_NAVIGATION_KEY.UP ? -1 : 1
    return closestVerticalAction(actions, current, direction)?.value || null
  }
  if (key === MATRIX_NAVIGATION_KEY.HOME
    || key === MATRIX_NAVIGATION_KEY.END) {
    const candidates = options.ctrlKey || options.metaKey ? actions : rowActions
    const target = key === MATRIX_NAVIGATION_KEY.HOME
      ? candidates[0]
      : candidates[candidates.length - 1]
    return target?.value || null
  }
  return null
}
