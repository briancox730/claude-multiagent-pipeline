export const meta = {
  name: 'build-and-validate',
  description: 'Build an artifact against acceptance criteria, validate it with an independent agent, retry with specific feedback up to a cap, then escalate',
  whenToUse: 'Invoked by an orchestrator for a scoped task that has checkable acceptance criteria',
  phases: [
    { title: 'Build', detail: 'a builder produces the artifact against the acceptance criteria' },
    { title: 'Validate', detail: 'a separate agent checks the artifact, not the builder\'s self-report' },
    { title: 'Loop', detail: 'on failure, retry with the specific failures as feedback, capped, then escalate' },
  ],
}

// args = { task, acceptance: [string...], context?, context_path?, max_retries? }
//   task        - one scoped unit of work, stated as an outcome
//   acceptance  - the checks the artifact must pass, written up front so both the builder
//                 and the validator work to the same bar
//   context     - optional inline background
//   context_path- optional file the builder Reads for large background (packs by reference)
//   max_retries - retries after the first attempt before escalating (default 2)
//
// IMPORTANT - what this workflow is and is not:
// The validator below is an AGENT check. It is a good first pass, and using a SEPARATE agent
// with a different framing than the builder is what makes it worth running at all. But an agent
// validator shares a lot of blind spots with the builder. The real gate is deterministic and
// runs in the ORCHESTRATOR that calls this workflow: re-run the actual test command, scan the
// real git history for secrets, grep for forbidden strings, run the build. See lib/gate.js and
// the README section "The independent validation gate". Two failures that agent-only validation
// misses, and the deterministic gate catches, are documented in the README.

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = A || {}

const task = A.task
const acceptance = Array.isArray(A.acceptance) ? A.acceptance : []
const maxRetries = Number.isInteger(A.max_retries) ? A.max_retries : 2

if (!task || !acceptance.length) {
  log('build-and-validate needs args {task, acceptance:[...]} - aborting')
  return null
}

const contextBlock = A.context
  ? `\n\nCONTEXT:\n${typeof A.context === 'string' ? A.context : JSON.stringify(A.context, null, 2)}`
  : A.context_path
    ? `\n\nCONTEXT: Read the file "${A.context_path}" first and treat it as authoritative background.`
    : ''

const acceptanceList = acceptance.map((c, i) => `${i + 1}. ${c}`).join('\n')
log(`build-and-validate: "${String(task).slice(0, 70)}" | ${acceptance.length} criteria | up to ${maxRetries} retr(ies)`)

// ---- structured-output schemas ----
const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    artifact: { type: 'string' },       // the deliverable (code, text, config) as a string
    summary: { type: 'string' },
    self_check: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          criterion: { type: 'string' },
          addressed: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['criterion', 'addressed'],
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['artifact', 'summary', 'self_check'],
}

const VALIDATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          criterion: { type: 'string' },
          passed: { type: 'boolean' },
          evidence: { type: 'string' },   // what in the artifact shows pass or fail
        },
        required: ['criterion', 'passed', 'evidence'],
      },
    },
    passed: { type: 'boolean' },
    blocking_failures: { type: 'array', items: { type: 'string' } },
    feedback: { type: 'string' },        // specific, actionable direction for the next attempt
  },
  required: ['checks', 'passed'],
}

// ---- prompts ----
const buildPrompt = (feedback) =>
  `You are completing ONE scoped task. Deliver an artifact that meets every acceptance criterion.\n\n` +
  `TASK:\n${task}${contextBlock}\n\n` +
  `ACCEPTANCE CRITERIA (all must hold):\n${acceptanceList}\n\n` +
  (feedback
    ? `YOUR PREVIOUS ATTEMPT FAILED VALIDATION. Fix exactly these and keep everything that already passed:\n${feedback}\n\n`
    : '') +
  `Produce the artifact. Then self_check each criterion honestly - mark addressed=false where you fell short rather than\n` +
  `claiming a pass you cannot back. List any assumptions. Return JSON.`

const validatePrompt = (build) =>
  `You are an independent validator. You did NOT write this artifact and you do not trust its self-report. Check the\n` +
  `artifact itself against each acceptance criterion.\n\n` +
  `TASK:\n${task}\n\nACCEPTANCE CRITERIA:\n${acceptanceList}\n\n` +
  `ARTIFACT AND THE BUILDER'S SELF-REPORT:\n${JSON.stringify(build, null, 2)}\n\n` +
  `For each criterion decide passed true/false with the specific evidence in the artifact that shows it. Set the top-level\n` +
  `passed=true only if EVERY criterion passes. If anything fails, list blocking_failures and write feedback that names the\n` +
  `exact fix so the next attempt does not repeat the miss. Default to failing a criterion you cannot positively confirm.`

// The loop. Plain JS - the harness gives agent()/parallel()/pipeline(), but a retry loop is
// just a while loop over await agent(). attempt is zero-indexed: attempt 0 is the first try,
// and with max_retries=2 the sequence is attempt 0, retry 1, retry 2, then escalate. That is
// three tries before a human is pulled in. The feedback carried into each retry is the
// validator's specific failures, not a bare "try again" - specific feedback is what stops the
// next attempt from reproducing the same mistake.
let attempt = 0
let feedback = null
let history = []

while (true) {
  phase('Build')
  const build = await agent(buildPrompt(feedback), { label: `build:attempt-${attempt}`, phase: 'Build', schema: BUILD_SCHEMA })

  phase('Validate')
  const result = await agent(validatePrompt(build), { label: `validate:attempt-${attempt}`, phase: 'Validate', schema: VALIDATE_SCHEMA, model: 'opus' })

  history.push({ attempt, summary: build && build.summary, passed: !!(result && result.passed), blocking_failures: (result && result.blocking_failures) || [] })

  if (result && result.passed) {
    log(`Accepted at attempt ${attempt}. Orchestrator must still run the deterministic gate before merge.`)
    return { status: 'accepted_pending_gate', attempt, build, validation: result, history }
  }

  if (attempt >= maxRetries) {
    log(`Escalating after ${attempt + 1} attempt(s) - retry cap reached.`)
    return {
      status: 'escalate',
      attempt,
      build,
      validation: result,
      history,
      handoff: {
        task,
        acceptance,
        attempts: attempt + 1,
        unresolved: (result && result.blocking_failures) || ['validator did not return a result'],
        note: 'A human should look at this. The agent could not satisfy the acceptance criteria within the retry cap.',
      },
    }
  }

  feedback = (result && result.feedback)
    || `Failed: ${((result && result.blocking_failures) || []).join('; ') || 'unknown'}. Re-read every acceptance criterion.`
  attempt += 1
  phase('Loop')
  log(`Attempt ${attempt - 1} failed validation; retrying with specific feedback (attempt ${attempt}).`)
}
