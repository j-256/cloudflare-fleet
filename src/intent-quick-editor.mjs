import { buildFacetIntentDocument, FACET_INTENT_MODE } from "./intent-shortcuts.mjs"
import { fleetIntentGroupZoneIds, FLEET_INTENT_ALL_ZONES_GROUP_ID, FLEET_INTENT_GROUP_MODE, FLEET_INTENT_PRESENCE_CONSTRAINT, FLEET_INTENT_VALUE_CONSTRAINT } from "./fleet-intent.mjs"
import { groupFleetRowIntentValues } from "./value-comparison.mjs"
import { stableString } from "./normalize.mjs"
import { createZonePicker } from "./zone-picker.mjs"

const INTENT_SCOPE_MODE = Object.freeze({ GROUPS: "groups", ZONES: "zones" })

export function openFacetIntentEditor(options) {
  const { dialog, intent } = options
  const document = dialog.ownerDocument
  const make = (tag, text = "", className = "") => {
    const node = document.createElement(tag)
    node.textContent = text
    node.className = className
    return node
  }
  const button = (text, handler, className = "button button-quiet") => {
    const node = make("button", text, className)
    node.type = "button"
    if (handler) node.addEventListener("click", handler)
    return node
  }
  let inventory = options.inventory
  let matrix = options.matrix
  const rows = options.rows
  const facets = rows.map((row) => ({ category: row.category, key: row.key, ...(row.phase ? { phase: row.phase } : {}) }))
  const single = rows.length === 1
  const policies = single ? intent.policies.filter((policy) => policy.facet.category === rows[0].category && policy.facet.key === rows[0].key) : []
  const prior = options.policy || policies[0]
  let mode = options.mode || (prior ? FACET_INTENT_MODE.SAVED : FACET_INTENT_MODE.CURRENT)
  let scopeMode = options.zoneIds?.length ? INTENT_SCOPE_MODE.ZONES : INTENT_SCOPE_MODE.GROUPS
  let ready = false
  let saving = false
  let desired = null
  let baseGroupIds = []
  let selectedGroups = new Set()
  let picker
  const form = make("form")
  form.method = "dialog"
  const heading = make("h2", single ? rows[0].label : `Set intent for ${rows.length} facets`)
  heading.id = "facet-intent-title"
  const close = button("\u00d7", () => dialog.close(), "dialog-close")
  close.setAttribute("aria-label", "Close intent editor")
  const help = make("p", "Save what should be true. This changes saved intent only.", "operator-help")
  const modes = make("div", "", "operator-choice-row")
  modes.setAttribute("role", "group")
  modes.setAttribute("aria-label", "Intent expectation")
  const modeButtons = new Map()
  for (const [value, label] of [[FACET_INTENT_MODE.SAVED, "Keep saved expectation"], [FACET_INTENT_MODE.CURRENT, "Current state is good"], [FACET_INTENT_MODE.SOURCE, "Match a zone"], [FACET_INTENT_MODE.ABSENT, "Must be absent"]]) {
    if (!single && value !== FACET_INTENT_MODE.CURRENT || value === FACET_INTENT_MODE.SAVED && !prior) continue
    const control = button(label, () => { mode = value; render() })
    modeButtons.set(value, control)
    modes.append(control)
  }
  const valueArea = make("div", "", "operator-value-area")
  const sourceLabel = make("label", "Use the value from")
  sourceLabel.htmlFor = "facet-intent-source"
  const source = make("select")
  source.id = "facet-intent-source"
  const valuePreview = make("div", "", "operator-value-preview")
  valueArea.append(sourceLabel, source, valuePreview)
  const scope = make("fieldset", "", "operator-scope")
  scope.append(make("legend", "Applies to"))
  const scopeTabs = make("div", "", "operator-choice-row")
  const groupTab = button("Groups", () => { scopeMode = INTENT_SCOPE_MODE.GROUPS; render() })
  const zoneTab = button("Individual zones", () => {
    if (scopeMode === INTENT_SCOPE_MODE.GROUPS) renderZonePicker([...new Set(intent.groups.filter((group) => selectedGroups.has(group.id)).flatMap((group) => fleetIntentGroupZoneIds(group, inventory)))])
    scopeMode = INTENT_SCOPE_MODE.ZONES
    render()
  })
  scopeTabs.append(groupTab, zoneTab)
  const groupArea = make("div")
  const groupSearch = make("input")
  groupSearch.type = "search"
  groupSearch.placeholder = "Find a group or zone"
  groupSearch.setAttribute("aria-label", "Search intent groups")
  const groupList = make("div", "", "zone-picker-options operator-group-options")
  groupArea.append(groupSearch, groupList)
  const zoneArea = make("div")
  scope.append(scopeTabs, groupArea, zoneArea)
  const outsideLabel = make("label", "", "zone-picker-option operator-outside")
  const outside = make("input")
  outside.type = "checkbox"
  outsideLabel.append(outside, make("span", "Must be absent everywhere else"))
  outside.addEventListener("change", render)
  const selection = make("p", "", "operator-selection-summary")
  const preview = make("div", "", "operator-intent-preview")
  const error = make("p", "", "field-error")
  error.setAttribute("role", "alert")
  const status = make("p", "Reading live values...", "operator-read-status")
  status.setAttribute("role", "status")
  const actions = make("div", "", "dialog-actions")
  if (single) actions.append(button("Advanced", () => { dialog.close(); options.advanced?.() }))
  actions.append(make("span", "", "dialog-action-spacer"), button("Cancel", () => dialog.close()))
  const save = button("Save intent", null, "button button-primary")
  save.type = "submit"
  actions.append(save)
  form.append(close, make("p", "Fleet intent", "dialog-kicker"), heading, help, modes, valueArea, scope, outsideLabel, selection, preview, error, status, actions)
  dialog.replaceChildren(form)
  dialog.setAttribute("aria-labelledby", heading.id)

  function variants() {
    const row = matrix.rows.find((row) => row.category === rows[0].category && row.key === rows[0].key)
    return row ? groupFleetRowIntentValues(row, inventory.zones) : []
  }
  function selectedVariant() {
    return variants().find((variant) => variant.zones.some((zone) => zone.id === source.value))
  }
  function populateSources() {
    const old = source.value
    source.replaceChildren()
    for (const variant of variants()) {
      for (const zone of variant.zones) {
        const option = make("option", zone.name)
        option.value = zone.id
        source.append(option)
      }
    }
    const preferred = variants().find((variant) => variant.canonical === prior?.expected?.canonical)
    source.value = [...source.options].some((option) => option.value === old) ? old : preferred?.sourceZoneId || source.options[0]?.value || ""
  }
  function chooseMatchingGroups() {
    baseGroupIds = mode === FACET_INTENT_MODE.CURRENT ? [] : policies.filter((policy) => mode === FACET_INTENT_MODE.SAVED
      ? policy.presenceConstraint === prior.presenceConstraint && policy.valueConstraint === prior.valueConstraint && policy.expected?.canonical === prior.expected?.canonical
      : mode === FACET_INTENT_MODE.ABSENT
      ? policy.presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
      : policy.expected?.canonical === selectedVariant()?.canonical && policy.valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT && policy.presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED).map((policy) => policy.groupId)
    selectedGroups = new Set(baseGroupIds.length ? baseGroupIds : [FLEET_INTENT_ALL_ZONES_GROUP_ID])
    renderGroups()
  }
  function renderGroups() {
    groupList.replaceChildren()
    for (const group of intent.groups) {
      const label = make("label", "", "zone-picker-option")
      const control = make("input")
      control.type = "checkbox"
      control.value = group.id
      control.checked = selectedGroups.has(group.id)
      control.addEventListener("change", () => {
        if (control.checked && group.mode === FLEET_INTENT_GROUP_MODE.ALL) selectedGroups.clear()
        if (control.checked && group.mode !== FLEET_INTENT_GROUP_MODE.ALL) selectedGroups.delete(FLEET_INTENT_ALL_ZONES_GROUP_ID)
        if (control.checked) selectedGroups.add(group.id)
        else selectedGroups.delete(group.id)
        for (const checkbox of groupList.querySelectorAll("input")) checkbox.checked = selectedGroups.has(checkbox.value)
        render()
      })
      const names = fleetIntentGroupZoneIds(group, inventory).map((id) => inventory.zones.find((zone) => zone.meta.id === id)?.meta.name || id)
      const copy = make("span")
      copy.append(make("strong", group.name), make("small", group.mode === FLEET_INTENT_GROUP_MODE.ALL ? "All loaded zones" : names.join(", ")))
      label.append(control, copy)
      label.dataset.search = `${group.name} ${names.join(" ")}`.toLowerCase()
      groupList.append(label)
    }
    filterGroups()
  }
  function filterGroups() {
    for (const label of groupList.children) label.hidden = !label.dataset.search.includes(groupSearch.value.trim().toLowerCase())
  }
  groupSearch.addEventListener("input", filterGroups)
  source.addEventListener("change", render)
  function request() {
    return {
      facets, mode,
      ...(scopeMode === INTENT_SCOPE_MODE.GROUPS ? { groupIds: [...selectedGroups], removeGroupIds: mode === FACET_INTENT_MODE.CURRENT ? [] : baseGroupIds.filter((id) => !selectedGroups.has(id)) } : { zoneIds: picker?.selectedZoneIds() || [] }),
      ...(mode === FACET_INTENT_MODE.SOURCE ? { sourceZoneId: source.value, absentOutside: outside.checked } : {}),
      ...(mode === FACET_INTENT_MODE.SAVED ? { policyId: prior.id, absentOutside: outside.checked } : {}),
    }
  }
  function render() {
    for (const [value, control] of modeButtons) control.setAttribute("aria-pressed", String(mode === value))
    groupTab.setAttribute("aria-pressed", String(scopeMode === INTENT_SCOPE_MODE.GROUPS))
    zoneTab.setAttribute("aria-pressed", String(scopeMode === INTENT_SCOPE_MODE.ZONES))
    groupArea.hidden = scopeMode !== INTENT_SCOPE_MODE.GROUPS
    zoneArea.hidden = scopeMode !== INTENT_SCOPE_MODE.ZONES
    valueArea.hidden = mode !== FACET_INTENT_MODE.SOURCE
    outsideLabel.hidden = ![FACET_INTENT_MODE.SOURCE, FACET_INTENT_MODE.SAVED].includes(mode)
    valuePreview.replaceChildren()
    const variant = selectedVariant()
    if (variant && mode === FACET_INTENT_MODE.SOURCE) valuePreview.append(options.renderValue(rows[0], variant))
    preview.replaceChildren()
    error.textContent = ""
    desired = null
    try {
      const result = buildFacetIntentDocument(intent, inventory, matrix, request())
      desired = result.document
      const names = result.zoneIds.map((id) => inventory.zones.find((zone) => zone.meta.id === id)?.meta.name || id)
      selection.textContent = `${result.zoneIds.length} zones selected: ${names.join(", ")}`
      if (mode === FACET_INTENT_MODE.CURRENT) {
        const present = result.summaries.reduce((total, entry) => total + entry.present, 0)
        const absent = result.summaries.reduce((total, entry) => total + entry.absent, 0)
        preview.append(make("p", `Keep ${present} present ${present === 1 ? "value" : "values"}${absent ? ` and ${absent} ${absent === 1 ? "absence" : "absences"}` : ""} exactly as observed. Differences between zones stay intentional.`))
        if (single) {
          for (const variant of variants()) {
            const names = variant.zones.filter((zone) => result.zoneIds.includes(zone.id)).map((zone) => zone.name)
            if (!names.length) continue
            const item = make("div", "", "operator-current-value")
            item.append(make("strong", names.join(", ")), options.renderValue(rows[0], variant, { compact: true }))
            preview.append(item)
          }
          const absentNames = result.zoneIds.filter((id) => !variants().some((variant) => variant.zones.some((zone) => zone.id === id)))
            .map((id) => inventory.zones.find((zone) => zone.meta.id === id).meta.name)
          if (absentNames.length) preview.append(make("p", `Keep absent: ${absentNames.join(", ")}`))
        } else {
          preview.append(make("p", rows.map((row) => row.label).join(", ")))
        }
      } else {
        if (mode === FACET_INTENT_MODE.SAVED) {
          preview.append(make("p", `Keep saved intent: ${prior.presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN ? "Must be absent" : `${prior.presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL ? "Optional presence" : "Required presence"}, ${prior.valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT ? "exact value" : prior.valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER ? "values must differ" : "values may differ"}`}.`))
          if (prior.expected) preview.append(options.renderValue(rows[0], { ...prior.expected, inspectionValue: prior.expected.value }, { compact: true }))
        }
        preview.append(make("p", mode === FACET_INTENT_MODE.ABSENT ? "This facet must be absent in the selected scope." : mode === FACET_INTENT_MODE.SAVED ? "Apply this saved expectation to the selected groups or zones. Existing exceptions inside this selection will be replaced." : "The selected groups or zones will require this value. Existing exceptions inside this selection will be replaced."))
        if (request().removeGroupIds?.length) preview.append(make("p", `Remove this expectation from: ${request().removeGroupIds.map((id) => intent.groups.find((group) => group.id === id).name).join(", ")}. Other applicable intent still applies.`))
        if (outside.checked && [FACET_INTENT_MODE.SOURCE, FACET_INTENT_MODE.SAVED].includes(mode)) preview.append(make("p", "Replace other scopes for this facet with an absence default outside the selection."))
      }
    } catch (failure) {
      selection.textContent = ""
      error.textContent = failure.message
    }
    save.disabled = !ready || saving || !desired
  }

  populateSources()
  chooseMatchingGroups()
  function renderZonePicker(selectedZoneIds) {
    picker = createZonePicker(zoneArea, { zones: inventory.zones, groups: intent.groups, selectedZoneIds, searchLabel: "Search intent zones", onChange: () => render() })
  }
  renderZonePicker(options.zoneIds?.length ? options.zoneIds : inventory.zones.map((zone) => zone.meta.id))
  render()
  dialog.showModal()
  const controller = new AbortController()
  dialog.addEventListener("close", () => controller.abort(), { once: true })
  async function refresh() {
    const loaded = await options.loadFresh(request(), controller.signal)
    inventory = loaded.inventory
    matrix = loaded.matrix
    populateSources()
    ready = true
    status.textContent = "Live values loaded. Save intent to record this expectation."
    render()
  }
  refresh().catch((failure) => {
    if (controller.signal.aborted) return
    status.textContent = ""
    error.textContent = failure.message
    actions.prepend(button("Retry read", () => refresh().catch((failure) => { error.textContent = failure.message })))
  })
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (!desired || saving || !ready) return
    const reviewed = stableString(desired)
    saving = true
    save.textContent = "Saving..."
    save.disabled = true
    try {
      await refresh()
      if (controller.signal.aborted) return
      if (!desired || stableString(desired) !== reviewed) {
        error.textContent = "Live values changed. Review the updated expectation and save again."
        return
      }
      if (await options.save(desired, save)) dialog.close()
    } catch (failure) {
      if (!controller.signal.aborted) error.textContent = failure.message
    } finally {
      saving = false
      save.textContent = "Save intent"
      save.disabled = !ready || !desired
    }
  })
}
