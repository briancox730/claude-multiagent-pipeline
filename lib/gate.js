// The independent validation gate.
//
// After an agent reports that it finished a task, the orchestrator runs these checks
// ITSELF. It does not accept the agent's self-report as evidence. The agent that wrote
// the code shares the blind spots of any agent asked to review the same code, so the
// gate has to be something the orchestrator can run deterministically: a string scan,
// a secret scan over the real git history, a re-run of the actual test command.
//
// All functions here are pure and unit-tested in test/gate.test.js. The parts that
// touch the world (running git, running the test command) live in the orchestrator,
// not here, so this module stays testable offline.

// A starter set of secret shapes. Extend per project. These are intentionally narrow
// to keep false positives low; a real gate pairs them with an entropy check.
export const SECRET_PATTERNS = [
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'generic-secret-assignment', re: /\b(?:secret|token|api[_-]?key|password)\s*[:=]\s*['"][A-Za-z0-9/+_-]{16,}['"]/i },
]

// scanForbidden(text, patterns) -> [{ name, index, match? }]
// A pattern is either a literal string (matched case-insensitively) or an object
// { name, re }. Use the string form for a project's forbidden-word list and the
// object form for secret shapes. Returns one hit per matching pattern.
export function scanForbidden(text, patterns) {
  const s = String(text)
  const lower = s.toLowerCase()
  const hits = []
  for (const p of patterns) {
    if (typeof p === 'string') {
      const idx = lower.indexOf(p.toLowerCase())
      if (idx !== -1) hits.push({ name: p, index: idx })
    } else if (p && p.re) {
      const m = p.re.exec(s)
      if (m) hits.push({ name: p.name, index: m.index, match: m[0] })
    }
  }
  return hits
}

// evaluateGate(checks) -> { passed, failures }
// checks: [{ name, passed, detail? }]. The orchestrator fills this array from the
// results of the deterministic checks it ran (tests, secret scan, forbidden-string
// scan, build). The gate passes only if every check passed.
export function evaluateGate(checks) {
  const failures = checks
    .filter((c) => !c.passed)
    .map((c) => ({ name: c.name, detail: c.detail || '' }))
  return { passed: failures.length === 0, failures }
}

// retryDecision({ attempt, maxRetries, passed, failures }) -> a control decision.
//
// `attempt` is zero-indexed: the first attempt is 0. With the default maxRetries of 2
// the sequence is attempt 0 (initial), then retry 1, then retry 2, then escalate.
// That is three total tries before a human is pulled in.
//
// Returns one of:
//   { action: 'accept' }
//   { action: 'retry', nextAttempt, feedback }   feedback names the exact failures
//   { action: 'escalate', reason, failures }     hand to a human, do not loop forever
export function retryDecision({ attempt, maxRetries = 2, passed, failures = [] }) {
  if (passed) return { action: 'accept' }
  if (attempt >= maxRetries) {
    return { action: 'escalate', reason: `failed after ${attempt + 1} attempt(s)`, failures }
  }
  return {
    action: 'retry',
    nextAttempt: attempt + 1,
    feedback: buildFeedback(failures),
  }
}

// Turn a list of failures into feedback the next attempt can act on. Specific beats
// general: a retry that just says "try again" tends to reproduce the same miss.
export function buildFeedback(failures) {
  if (!failures.length) return 'The validation gate failed. Re-check every acceptance criterion before resubmitting.'
  return [
    'Your previous attempt failed these specific checks. Fix ONLY these and resubmit:',
    ...failures.map((f, i) => `${i + 1}. ${f.name}${f.detail ? ` - ${f.detail}` : ''}`),
  ].join('\n')
}
