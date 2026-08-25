export const meta = {
  name: 'adversarial-review',
  description: 'Review a code change from several angles, verify each finding independently, then synthesize one report',
  whenToUse: 'Invoked by the /adversarial-review skill to turn a diff or file (passed by file reference) into a decision-grade review',
  phases: [
    { title: 'Find', detail: 'parallel finders, one per review angle' },
    { title: 'Verify', detail: 'each finding re-checked by a separate agent that defaults to rejecting' },
    { title: 'Synthesize', detail: 'surviving findings consolidated into a review with a recommendation' },
  ],
}

// args = { targets: [id...], packs_dir?, packs?, angles? }
//   A "target" is one code artifact under review (a diff, a file, a changeset). Its
//   ground truth is a PACK: the actual code text plus any context the reviewer needs.
//   Packs arrive inline (args.packs[id]) or by file reference (args.packs_dir with one
//   <id>.json per target). File mode keeps large diffs out of the orchestrator context;
//   each agent Reads only its own pack. Inline wins when both are present.
//
// This script is self-contained on purpose: the harness runs it as a standalone script
// and does not resolve local imports, so the pack resolver and schemas live inline here.
// lib/packs.js and lib/schema.js hold the unit-tested versions of the same logic.

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = A || {}

const packs = A.packs || {}
const packsDir = A.packs_dir || null
const targets = (A.targets || Object.keys(packs)).filter((t) => packs[t] || packsDir)

// Default review angles. Each angle is one finder with a distinct mandate, so the finders
// do not all report the same obvious bug and miss the rest. Override via args.angles.
const ANGLES = A.angles || [
  { key: 'correctness', brief: 'logic errors, off-by-one and boundary mistakes, wrong control flow, unhandled error paths, broken invariants' },
  { key: 'security', brief: 'injection, missing authz/authn checks, unsafe deserialization, secrets in code, unvalidated input crossing a trust boundary' },
  { key: 'resource', brief: 'resource leaks, unbounded growth, races and lock misuse, N+1 access patterns, blocking calls on a hot path' },
]

if (!targets.length) {
  log('No targets supplied - nothing to review.')
  return []
}
log(`Adversarial review of ${targets.length} target(s): ${targets.join(', ')}`)

// ---- structured-output schemas ----
const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          location: { type: 'string' },   // file:line or function, so a reader can go look
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          explanation: { type: 'string' },
          suggested_fix: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'med', 'low'] },
        },
        required: ['title', 'location', 'severity', 'explanation', 'confidence'],
      },
    },
    note: { type: 'string' },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    survives: { type: 'boolean' },
    reproducible: { type: 'string', enum: ['yes', 'no', 'unclear'] },
    corrected_severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
    reason: { type: 'string' },
  },
  required: ['survives', 'reproducible', 'reason'],
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    target: { type: 'string' },
    summary: { type: 'string' },
    recommendation: { type: 'string', enum: ['approve', 'approve_with_nits', 'request_changes', 'block'] },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          location: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          explanation: { type: 'string' },
          suggested_fix: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'med', 'low'] },
        },
        required: ['title', 'location', 'severity', 'explanation'],
      },
    },
    dropped: { type: 'array', items: { type: 'string' } },        // findings the verifier rejected
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['target', 'summary', 'recommendation', 'findings'],
}

// ---- prompt helpers ----
const packRef = (t) => packs[t]
  ? JSON.stringify(packs[t], null, 2)
  : `(READ YOUR PACK FIRST: use the Read tool on the file "${packsDir}/${t}.json". Its JSON content IS the\n` +
    `change under review for ${t} - the diff/file text plus context. Treat it as the authoritative source;\n` +
    `review only what is actually in it and cite exact locations from it.)`

const RULES =
  `RULES - a maintainer acts on this, so precision beats volume:\n` +
  `- Only report a problem you can tie to a specific location in the pack. Vague worries are noise.\n` +
  `- Do not dress style preferences as bugs. If it is a preference, mark it a nit and say so.\n` +
  `- When unsure a thing is real, lower the severity and set confidence "low" rather than dropping it.\n` +
  `- Give a concrete suggested_fix where you can. "This is wrong" without a direction wastes the reader's time.`

function findPrompt(t, angle) {
  return `You are reviewing a code change for ${t}, focused ONLY on the ${angle.key.toUpperCase()} angle.\n\n` +
    `CHANGE UNDER REVIEW:\n${packRef(t)}\n\n` +
    `Look specifically for: ${angle.brief}.\n` +
    `Report every issue you can support with a specific location. 0-6 findings. ${RULES}\n\nReturn JSON {findings:[...]}.`
}

function verifyPrompt(t, finding) {
  return `You are a skeptical reviewer whose job is to keep false findings out of a review. Independently re-check ONE\n` +
    `reported issue against the actual change. Do not assume the finder was right.\n\n` +
    `CHANGE UNDER REVIEW:\n${packRef(t)}\n\n` +
    `REPORTED ISSUE:\n${JSON.stringify(finding, null, 2)}\n\n` +
    `Go to the cited location and decide: is this real, in THIS change, as described? Set survives=true ONLY if you can\n` +
    `reproduce the problem from the code in the pack. DEFAULT to survives=false for anything vague, speculative, already\n` +
    `handled elsewhere in the change, or not actually present. If the issue is real but mis-sized, set corrected_severity.\n` +
    `Give a one-to-two sentence reason a maintainer could check.`
}

function synthPrompt(t, survivors, dropped) {
  return `You are the lead reviewer writing the final review for ${t}. A maintainer will act on it, so be direct and honest.\n\n` +
    `CHANGE UNDER REVIEW:\n${packRef(t)}\n\n` +
    `SURVIVING FINDINGS (each already independently verified):\n${JSON.stringify(survivors, null, 2)}\n\n` +
    `REJECTED FINDINGS (verifier could not reproduce these - do NOT reinstate them):\n${JSON.stringify(dropped, null, 2)}\n\n` +
    `Produce the review JSON:\n` +
    `- findings: keep only the surviving ones; use each verifier's corrected_severity where present; merge duplicates.\n` +
    `- recommendation: block if any blocker survives; request_changes if any major survives; approve_with_nits if only\n` +
    `  minors/nits remain; approve if nothing material survives. Be calibrated, not lenient.\n` +
    `- summary: two-to-four sentences naming the single most important issue first.\n` +
    `- dropped: one line each for the rejected findings, so the reader sees what was considered and why it was cut.\n` +
    `- open_questions: anything you could not settle from the pack alone. Set target="${t}".`
}

// pipeline: each target flows Find -> Verify -> Synthesize independently. A pipeline fits
// here because targets do not depend on each other. Nothing about reviewing target B needs
// target A's result, so we never make B wait on A. (Contrast judge-panel.js, where a barrier
// is required because the scoring stage compares candidates against one another.)
const reviews = await pipeline(
  targets,
  // Find: run every angle in parallel, then flatten to a flat finding list.
  async (t) => {
    const perAngle = await parallel(
      ANGLES.map((angle) => () =>
        agent(findPrompt(t, angle), { label: `find:${angle.key}:${t}`, phase: 'Find', schema: FINDINGS_SCHEMA })
          .then((r) => ((r && r.findings) || []).map((f) => ({ ...f, angle: angle.key })))
          .catch(() => [])),
    )
    const findings = perAngle.flat()
    log(`${t}: ${findings.length} raw finding(s) across ${ANGLES.length} angle(s)`)
    return { t, findings }
  },
  // Verify: re-check EACH finding with its own agent, in parallel. Per-finding independence is
  // the point - a verifier judging one claim at a time cannot be swayed by a confident-sounding
  // batch. If a target routinely produces many findings and cost matters, batch a few per
  // verifier; the tradeoff is that batching reintroduces cross-claim influence.
  async ({ t, findings }) => {
    if (!findings.length) return { t, survivors: [], dropped: [] }
    const verdicts = await parallel(
      findings.map((f) => () =>
        agent(verifyPrompt(t, f), { label: `verify:${t}`, phase: 'Verify', schema: VERDICT_SCHEMA })
          .then((v) => ({ finding: f, v }))
          .catch(() => ({ finding: f, v: { survives: false, reproducible: 'unclear', reason: 'verifier failed to run' } }))),
    )
    const survivors = verdicts
      .filter((x) => x.v && x.v.survives)
      .map((x) => ({ ...x.finding, severity: x.v.corrected_severity || x.finding.severity, verify_reason: x.v.reason }))
    const dropped = verdicts
      .filter((x) => !(x.v && x.v.survives))
      .map((x) => `${x.finding.title} @ ${x.finding.location} - ${x.v ? x.v.reason : 'rejected'}`)
    log(`${t}: ${survivors.length} finding(s) survived, ${dropped.length} dropped`)
    return { t, survivors, dropped }
  },
  // Synthesize: one report per target from the survivors.
  async ({ t, survivors, dropped }) => {
    const review = await agent(synthPrompt(t, survivors, dropped), { label: `synth:${t}`, phase: 'Synthesize', schema: REVIEW_SCHEMA })
    if (review && !review.target) review.target = t
    return review
  },
)

const ok = reviews.filter(Boolean)
log(`Wrote ${ok.length}/${targets.length} review(s).`)
return ok
