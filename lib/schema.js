// Minimal JSON-Schema validator and a few schema builders.
//
// Why this exists: the workflow scripts ask agents for structured output against a
// JSON schema, and the harness enforces that schema when the model returns. This
// module lets an orchestrator re-check a payload itself before trusting it, which is
// the "verify by re-deriving, do not trust the report" idea applied to schema shape.
// It supports only the subset of JSON Schema the workflows use.
//
// The validator is pure and has no dependency on the harness, so it is unit-tested
// in test/schema.test.js without any live agents.

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
}

// validate(schema, value) -> { valid: boolean, errors: string[] }
// Errors carry a JSON-path-ish location so a failure points at the offending field.
export function validate(schema, value) {
  const errors = []
  walk(schema, value, '$', errors)
  return { valid: errors.length === 0, errors }
}

function walk(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return

  if (schema.type) {
    const checker = TYPE_CHECKS[schema.type]
    if (checker && !checker(value)) {
      errors.push(`${path}: expected ${schema.type}, got ${describe(value)}`)
      return // a wrong type makes every downstream check meaningless
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not one of [${schema.enum.join(', ')}]`)
  }

  if (schema.type === 'object' && TYPE_CHECKS.object(value)) {
    const props = schema.properties || {}
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: required property missing`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}.${key}: additional property not allowed`)
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) walk(sub, value[key], `${path}.${key}`, errors)
    }
  }

  if (schema.type === 'array' && TYPE_CHECKS.array(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} item(s), got ${value.length}`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: expected at most ${schema.maxItems} item(s), got ${value.length}`)
    }
    if (schema.items) value.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors))
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: ${value} below minimum ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: ${value} above maximum ${schema.maximum}`)
    }
  }
}

function describe(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// Small builders that make the workflow schemas read closer to their intent.
// Every object built here sets additionalProperties:false, because a strict schema
// is what makes a model return exactly the fields you asked for and nothing extra.
export const S = {
  str: (opts = {}) => ({ type: 'string', ...opts }),
  int: (opts = {}) => ({ type: 'integer', ...opts }),
  num: (opts = {}) => ({ type: 'number', ...opts }),
  bool: () => ({ type: 'boolean' }),
  enum: (values) => ({ type: 'string', enum: values }),
  arr: (items, opts = {}) => ({ type: 'array', items, ...opts }),
  obj: (properties, required = []) => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  }),
}
