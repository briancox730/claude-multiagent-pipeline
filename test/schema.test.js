import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate, S } from '../lib/schema.js'

// A representative workflow schema built with the S builders.
const FINDING = S.obj(
  {
    title: S.str(),
    severity: S.enum(['blocker', 'major', 'minor', 'nit']),
    confidence: S.enum(['high', 'med', 'low']),
    line: S.int({ minimum: 1 }),
  },
  ['title', 'severity', 'confidence'],
)

test('accepts a well-formed object', () => {
  const { valid, errors } = validate(FINDING, {
    title: 'off-by-one in range check',
    severity: 'major',
    confidence: 'high',
    line: 42,
  })
  assert.equal(valid, true)
  assert.deepEqual(errors, [])
})

test('flags a missing required property', () => {
  const { valid, errors } = validate(FINDING, { title: 'x', severity: 'minor' })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes('confidence') && e.includes('required')))
})

test('rejects an additional property when additionalProperties is false', () => {
  const { valid, errors } = validate(FINDING, {
    title: 'x', severity: 'minor', confidence: 'low', extra: true,
  })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes('extra') && e.includes('additional property')))
})

test('rejects a value outside an enum', () => {
  const { valid, errors } = validate(FINDING, {
    title: 'x', severity: 'catastrophic', confidence: 'low',
  })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes('severity') && e.includes('not one of')))
})

test('reports a type mismatch and stops descending into it', () => {
  const { valid, errors } = validate(FINDING, {
    title: 123, severity: 'minor', confidence: 'low',
  })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes('title') && e.includes('expected string')))
})

test('enforces numeric minimum', () => {
  const { valid, errors } = validate(FINDING, {
    title: 'x', severity: 'minor', confidence: 'low', line: 0,
  })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes('line') && e.includes('minimum')))
})

test('integer type rejects a float', () => {
  const { valid } = validate(S.int(), 3.5)
  assert.equal(valid, false)
})

test('validates arrays and nested items with a path', () => {
  const schema = S.obj({ findings: S.arr(FINDING, { minItems: 1 }) }, ['findings'])
  const { valid, errors } = validate(schema, {
    findings: [
      { title: 'ok', severity: 'minor', confidence: 'low' },
      { title: 'bad', severity: 'minor' }, // missing confidence
    ],
  })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes('findings[1]') && e.includes('confidence')))
})

test('enforces array minItems', () => {
  const schema = S.arr(S.str(), { minItems: 2 })
  assert.equal(validate(schema, ['only-one']).valid, false)
  assert.equal(validate(schema, ['a', 'b']).valid, true)
})
