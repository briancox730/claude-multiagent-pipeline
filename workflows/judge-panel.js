export const meta = {
  name: 'judge-panel',
  description: 'Answer a hard question from N independent angles, score every candidate against a rubric, then synthesize the best answer',
  whenToUse: 'Invoked by the /judge-panel skill for open research questions where one attempt is not trustworthy on its own',
  phases: [
    { title: 'Attempt', detail: 'N solvers, each from a different angle, with no sight of each other' },
    { title: 'Score', detail: 'every candidate graded against the rubric in parallel' },
    { title: 'Synthesize', detail: 'a chair reconciles the scored candidates into one answer' },
  ],
}

// args = { question, angles?, rubric?, context?, context_path? }
//   question     - the thing to answer, stated plainly
//   angles       - override the default solver angles (each becomes one independent attempt)
//   rubric       - override the default scoring criteria
//   context      - optional inline background the solvers may use
//   context_path - optional file the solvers Read for large background (packs by reference)
//
// Self-contained by design (the harness runs this as a standalone script). See judge-panel's
// SKILL.md and README for when a judge panel beats a single strong answer.

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = A || {}

const question = A.question
if (!question) { log('judge-panel needs args.question - aborting'); return null }

// Different angles pull the solvers apart so the panel explores the space instead of
// converging on one framing. The independence is the value: if three solvers that could
// not see each other still agree, that agreement means something.
const ANGLES = A.angles || [
  { key: 'first-principles', brief: 'Reason from fundamentals. Build the answer up from what must be true, not from what is commonly said.' },
  { key: 'evidence-first', brief: 'Lead with sources and data. Ground every claim in something checkable and cite it.' },
  { key: 'devils-advocate', brief: 'Assume the obvious answer is wrong. Find the strongest case against it, then answer with that stress applied.' },
]

const RUBRIC = A.rubric || [
  { key: 'grounding', brief: 'Are claims supported by evidence or sound reasoning, with no invented facts?' },
  { key: 'completeness', brief: 'Does it address the whole question, including the parts that are inconvenient?' },
  { key: 'calibration', brief: 'Is it honest about uncertainty, neither hedging everything nor overclaiming?' },
]

const contextBlock = A.context
  ? `\n\nBACKGROUND (shared, may be used freely):\n${typeof A.context === 'string' ? A.context : JSON.stringify(A.context, null, 2)}`
  : A.context_path
    ? `\n\nBACKGROUND: Read the file "${A.context_path}" first and use it as shared background. Do not contradict it.`
    : ''

log(`Judge panel on: ${String(question).slice(0, 80)} | ${ANGLES.length} solver(s), ${RUBRIC.length} rubric criteria`)

// ---- structured-output schemas ----
const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    angle: { type: 'string' },
    answer: { type: 'string' },
    key_claims: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'med', 'low'] },
        },
        required: ['claim', 'confidence'],
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    sources: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { title: { type: 'string' }, url: { type: 'string' } },
        required: ['title'],
      },
    },
  },
  required: ['angle', 'answer', 'key_claims'],
}

const SCORE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    candidate: { type: 'string' },       // the angle key of the candidate being scored
    scores: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          criterion: { type: 'string' },
          score: { type: 'integer', minimum: 1, maximum: 5 },
          reason: { type: 'string' },
        },
        required: ['criterion', 'score', 'reason'],
      },
    },
    fatal_flaws: { type: 'array', items: { type: 'string' } },
    overall: { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['candidate', 'scores', 'overall'],
}

const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    answer: { type: 'string' },
    drawn_from: { type: 'array', items: { type: 'string' } },   // which candidate angles fed the final answer
    why: { type: 'string' },
    residual_uncertainty: { type: 'array', items: { type: 'string' } },
    sources: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { title: { type: 'string' }, url: { type: 'string' } },
        required: ['title'],
      },
    },
  },
  required: ['answer', 'drawn_from', 'why'],
}

// ---- prompts ----
const solverPrompt = (angle) =>
  `You are answering a hard question. Your assigned angle: ${angle.brief}\n\n` +
  `QUESTION:\n${question}${contextBlock}\n\n` +
  `Answer from your angle only. State your key claims with the evidence behind each, list the assumptions you had to\n` +
  `make, and cite sources where the answer rests on facts. Do not hedge into fog and do not overclaim. Return JSON.`

const scorePrompt = (candidate) =>
  `You are a judge scoring ONE candidate answer against a fixed rubric. Be strict and specific.\n\n` +
  `QUESTION:\n${question}\n\n` +
  `RUBRIC (score each 1-5, where 5 is excellent):\n${RUBRIC.map((r) => `- ${r.key}: ${r.brief}`).join('\n')}\n\n` +
  `CANDIDATE ANSWER (angle "${candidate.angle}"):\n${JSON.stringify(candidate, null, 2)}\n\n` +
  `For each rubric criterion give a 1-5 score with a concrete reason tied to the candidate's text. List any fatal_flaws\n` +
  `(a claim that is wrong, unsupported, or answers a different question). Give an overall 1-5. Set candidate="${candidate.angle}".`

const chairPrompt = (candidates, scores) =>
  `You are the chair. Produce the single best answer to the question by reconciling the scored candidates below.\n\n` +
  `QUESTION:\n${question}${contextBlock}\n\n` +
  `CANDIDATES:\n${JSON.stringify(candidates, null, 2)}\n\n` +
  `JUDGE SCORES:\n${JSON.stringify(scores, null, 2)}\n\n` +
  `Write the final answer. Take the strongest, best-scored claims and DROP anything a judge flagged as a fatal flaw or\n` +
  `left unsupported. Where the candidates genuinely disagree, say so and give your reasoned call rather than splitting\n` +
  `the difference. drawn_from = the angle keys you actually used. residual_uncertainty = what is still open. Return JSON.`

// The panel needs a BARRIER, not a pipeline. Every attempt must finish before scoring can
// begin, because a judge scores a candidate partly by how it stands against the others, and
// the chair needs the full slate. parallel() gives that barrier: it resolves only when all
// attempts are done. A pipeline would let candidate 1 race ahead to scoring before candidate 3
// exists, which defeats the comparison.

phase('Attempt')
const candidates = (await parallel(
  ANGLES.map((angle) => () =>
    agent(solverPrompt(angle), { label: `solve:${angle.key}`, phase: 'Attempt', schema: ANSWER_SCHEMA })
      .then((r) => (r ? { ...r, angle: r.angle || angle.key } : null))
      .catch(() => null)),
)).filter(Boolean)

if (!candidates.length) { log('All solvers failed - aborting'); return null }
log(`${candidates.length} candidate answer(s) in hand; scoring now`)

phase('Score')
const scores = (await parallel(
  candidates.map((c) => () =>
    agent(scorePrompt(c), { label: `score:${c.angle}`, phase: 'Score', schema: SCORE_SCHEMA })
      .then((s) => (s ? { ...s, candidate: s.candidate || c.angle } : null))
      .catch(() => null)),
)).filter(Boolean)

phase('Synthesize')
const final = await agent(chairPrompt(candidates, scores), { label: 'chair', phase: 'Synthesize', schema: SYNTH_SCHEMA, model: 'opus' })

return { question, candidates, scores, final }
