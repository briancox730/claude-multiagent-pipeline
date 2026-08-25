import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePacks, packRef, normalizeArgs } from '../lib/packs.js'

test('normalizeArgs parses a JSON string', () => {
  assert.deepEqual(normalizeArgs('{"a":1}'), { a: 1 })
})

test('normalizeArgs tolerates garbage and nullish input', () => {
  assert.deepEqual(normalizeArgs('not json'), {})
  assert.deepEqual(normalizeArgs(null), {})
  assert.deepEqual(normalizeArgs(undefined), {})
})

test('resolvePacks reads inline payloads', () => {
  const list = resolvePacks({ packs: { A: { n: 1 }, B: { n: 2 } } })
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], { id: 'A', mode: 'inline', data: { n: 1 } })
})

test('resolvePacks builds file paths from packs_dir', () => {
  const list = resolvePacks({ packs_dir: 'examples/packs', ids: ['A', 'B'] })
  assert.deepEqual(list, [
    { id: 'A', mode: 'file', path: 'examples/packs/A.json' },
    { id: 'B', mode: 'file', path: 'examples/packs/B.json' },
  ])
})

test('inline wins over file mode when both are present for an id', () => {
  const list = resolvePacks({ packs: { A: { n: 1 } }, packs_dir: 'd', ids: ['A'] })
  assert.equal(list[0].mode, 'inline')
})

test('resolvePacks drops ids with no pack in either mode', () => {
  const list = resolvePacks({ packs: { A: { n: 1 } }, ids: ['A', 'MISSING'] })
  assert.deepEqual(list.map((e) => e.id), ['A'])
})

test('resolvePacks accepts target objects with an id field', () => {
  const list = resolvePacks({ packs_dir: 'd', targets: [{ id: 'A' }, { id: 'B' }] })
  assert.deepEqual(list.map((e) => e.id), ['A', 'B'])
})

test('packRef inlines JSON for inline mode', () => {
  const ref = packRef({ id: 'A', mode: 'inline', data: { hello: 'world' } })
  assert.ok(ref.includes('"hello"'))
  assert.ok(ref.includes('"world"'))
})

test('packRef points file mode at the path with a Read instruction', () => {
  const ref = packRef({ id: 'A', mode: 'file', path: 'examples/packs/A.json' })
  assert.ok(ref.includes('examples/packs/A.json'))
  assert.ok(/read/i.test(ref))
  assert.ok(ref.includes('authoritative'))
})
