import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scanForbidden,
  evaluateGate,
  retryDecision,
  buildFeedback,
  SECRET_PATTERNS,
} from '../lib/gate.js'

test('scanForbidden finds a literal string case-insensitively', () => {
  const hits = scanForbidden('The INTERNAL codename is Blue.', ['internal'])
  assert.equal(hits.length, 1)
  assert.equal(hits[0].name, 'internal')
})

test('scanForbidden returns nothing on clean text', () => {
  assert.deepEqual(scanForbidden('nothing to see here', ['secret', 'forbidden']), [])
})

test('scanForbidden catches an AWS-shaped access key id', () => {
  const planted = 'const k = "AKIAIOSFODNN7EXAMPLE"'
  const hits = scanForbidden(planted, SECRET_PATTERNS)
  assert.ok(hits.some((h) => h.name === 'aws-access-key-id'))
})

test('scanForbidden catches a private key header', () => {
  const hits = scanForbidden('-----BEGIN OPENSSH PRIVATE KEY-----', SECRET_PATTERNS)
  assert.ok(hits.some((h) => h.name === 'private-key-block'))
})

test('scanForbidden does not fire on ordinary code', () => {
  const hits = scanForbidden('function add(a, b) { return a + b }', SECRET_PATTERNS)
  assert.deepEqual(hits, [])
})

test('evaluateGate passes when every check passes', () => {
  const r = evaluateGate([
    { name: 'tests', passed: true },
    { name: 'secret-scan', passed: true },
  ])
  assert.equal(r.passed, true)
  assert.deepEqual(r.failures, [])
})

test('evaluateGate collects the failing checks', () => {
  const r = evaluateGate([
    { name: 'tests', passed: false, detail: '2 failing' },
    { name: 'secret-scan', passed: true },
  ])
  assert.equal(r.passed, false)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].name, 'tests')
})

test('retryDecision accepts on pass', () => {
  assert.deepEqual(retryDecision({ attempt: 0, passed: true }), { action: 'accept' })
})

test('retryDecision retries with specific feedback on first failure', () => {
  const d = retryDecision({
    attempt: 0,
    maxRetries: 2,
    passed: false,
    failures: [{ name: 'tests', detail: '1 failing' }],
  })
  assert.equal(d.action, 'retry')
  assert.equal(d.nextAttempt, 1)
  assert.ok(d.feedback.includes('tests'))
  assert.ok(d.feedback.includes('1 failing'))
})

test('retryDecision escalates once the retry cap is reached', () => {
  const d = retryDecision({
    attempt: 2,
    maxRetries: 2,
    passed: false,
    failures: [{ name: 'tests', detail: 'still failing' }],
  })
  assert.equal(d.action, 'escalate')
  assert.ok(d.reason.includes('3'))
})

test('the default cap allows one initial try plus two retries', () => {
  // attempts 0 and 1 retry, attempt 2 escalates -> three total tries
  assert.equal(retryDecision({ attempt: 0, passed: false }).action, 'retry')
  assert.equal(retryDecision({ attempt: 1, passed: false }).action, 'retry')
  assert.equal(retryDecision({ attempt: 2, passed: false }).action, 'escalate')
})

test('buildFeedback is specific when failures are known', () => {
  const fb = buildFeedback([{ name: 'lint', detail: 'unused import' }])
  assert.ok(fb.includes('lint'))
  assert.ok(fb.includes('unused import'))
})
