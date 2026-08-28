export class CliUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = "CliUsageError"
  }
}

function optionLabel(definition) {
  return `--${definition.name}`
}

function setOptionValue(result, seen, definition, value) {
  const key = definition.key || definition.name.replaceAll("-", "")
  if (definition.multiple) {
    result[key].push(value)
    return
  }
  if (seen.has(definition.name)) {
    throw new CliUsageError(`${optionLabel(definition)} may only be provided once`)
  }
  seen.add(definition.name)
  result[key] = value
}

function requireOptionValue(argv, index, definition, attachedValue) {
  if (attachedValue !== null) {
    if (attachedValue.length === 0) {
      throw new CliUsageError(`${optionLabel(definition)} requires a value`)
    }
    return { index, value: attachedValue }
  }
  const value = argv[index + 1]
  if (value === undefined) {
    throw new CliUsageError(`${optionLabel(definition)} requires a value`)
  }
  return { index: index + 1, value }
}

function initializeResult(definitions) {
  const result = { positionals: [] }
  for (const definition of definitions) {
    const key = definition.key || definition.name.replaceAll("-", "")
    if (definition.multiple) result[key] = []
    else if (Object.hasOwn(definition, "default")) result[key] = definition.default
    else result[key] = definition.value === false ? false : null
  }
  return result
}

export function parseCliOptions(argv, definitions, options = {}) {
  const byLongName = new Map(definitions.map((definition) => [definition.name, definition]))
  const byShortName = new Map(
    definitions
      .filter((definition) => definition.short)
      .map((definition) => [definition.short, definition]),
  )
  const result = initializeResult(definitions)
  const seen = new Set()
  let passthrough = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (passthrough || argument === "-" || !argument.startsWith("-")) {
      result.positionals.push(argument)
      continue
    }
    if (argument === "--") {
      passthrough = true
      continue
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=")
      const name = argument.slice(2, equals === -1 ? undefined : equals)
      const attachedValue = equals === -1 ? null : argument.slice(equals + 1)
      const definition = byLongName.get(name)
      if (!definition) throw new CliUsageError(`Unknown option: --${name}`)
      if (definition.value === false) {
        if (attachedValue !== null) {
          throw new CliUsageError(`${optionLabel(definition)} does not take a value`)
        }
        setOptionValue(result, seen, definition, true)
        continue
      }
      const resolved = requireOptionValue(argv, index, definition, attachedValue)
      index = resolved.index
      setOptionValue(result, seen, definition, resolved.value)
      continue
    }

    let remainder = argument.slice(1)
    while (remainder.length > 0) {
      const shortName = remainder[0]
      remainder = remainder.slice(1)
      const definition = byShortName.get(shortName)
      if (!definition) throw new CliUsageError(`Unknown option: -${shortName}`)
      if (definition.value === false) {
        setOptionValue(result, seen, definition, true)
        continue
      }
      const attachedValue = remainder.length > 0 ? remainder : null
      const resolved = requireOptionValue(argv, index, definition, attachedValue)
      index = resolved.index
      setOptionValue(result, seen, definition, resolved.value)
      remainder = ""
    }
  }

  const minimum = options.minPositionals ?? 0
  const maximum = options.maxPositionals ?? minimum
  if (result.positionals.length < minimum || result.positionals.length > maximum) {
    const expected = minimum === maximum
      ? `${minimum}`
      : `${minimum}-${maximum}`
    throw new CliUsageError(
      `Expected ${expected} positional argument${maximum === 1 ? "" : "s"}, received ${result.positionals.length}`,
    )
  }
  return result
}
