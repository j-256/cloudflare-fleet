import { FLEET_INTENT_GROUP_MODE } from "./fleet-intent.mjs"

export function createZonePicker(container, options) {
  const excluded = new Set(options.excludedZoneIds || [])
  const zones = options.zones.filter((zone) => !excluded.has(zone.meta.id))
  const selected = new Set((options.selectedZoneIds || []).filter((id) => zones.some((zone) => zone.meta.id === id)))
  const document = container.ownerDocument
  const make = (tag, text = "", className = "") => {
    const element = document.createElement(tag)
    element.textContent = text
    element.className = className
    return element
  }
  const search = make("input")
  search.type = "search"
  search.placeholder = options.searchLabel || "Search destination zones"
  search.setAttribute("aria-label", options.searchLabel || "Search destination zones")
  const summary = make("p", "", "zone-picker-summary")
  summary.setAttribute("role", "status")
  const list = make("div", "", "zone-picker-options")
  const tools = make("div", "", "zone-picker-tools")
  const controls = []
  const changed = () => {
    for (const { control } of controls) control.checked = selected.has(control.value)
    summary.textContent = `${selected.size} selected of ${zones.length} available zones`
    options.onChange?.([...selected])
  }
  const button = (label, handler) => {
    const control = make("button", label, "button button-quiet")
    control.type = "button"
    control.addEventListener("click", handler)
    return control
  }
  tools.append(search, button("Select visible", () => {
    for (const { control, label } of controls) if (!label.hidden) selected.add(control.value)
    changed()
  }), button("Clear", () => { selected.clear(); changed() }))
  const groups = make("details", "", "zone-picker-groups")
  groups.append(make("summary", "Choose by group"))
  const groupButtons = make("div", "", "zone-picker-group-buttons")
  for (const group of options.groups || []) {
    const ids = group.mode === FLEET_INTENT_GROUP_MODE.ALL
      ? zones.map((zone) => zone.meta.id)
      : group.members.map((member) => member.zoneId).filter((id) => zones.some((zone) => zone.meta.id === id))
    if (ids.length === 0) continue
    const control = button(group.name, () => { for (const id of ids) selected.add(id); changed() })
    control.setAttribute("aria-label", `Select zones in ${group.name}`)
    groupButtons.append(control)
  }
  groups.append(groupButtons)
  groups.hidden = groupButtons.childElementCount === 0
  for (const zone of zones) {
    const label = make("label", "", "zone-picker-option")
    const control = make("input")
    control.type = "checkbox"
    control.value = zone.meta.id
    control.checked = selected.has(zone.meta.id)
    control.addEventListener("change", () => {
      if (control.checked) selected.add(control.value)
      else selected.delete(control.value)
      changed()
    })
    label.append(control, make("span", zone.meta.name))
    controls.push({ control, label, name: zone.meta.name.toLowerCase() })
    list.append(label)
  }
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase()
    for (const { label, name } of controls) label.hidden = !name.includes(query)
  })
  container.replaceChildren(tools, groups, summary, list)
  changed()
  return { selectedZoneIds: () => [...selected], search }
}
