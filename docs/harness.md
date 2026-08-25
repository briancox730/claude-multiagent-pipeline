# The harness contract

The workflow scripts in `workflows/` are written against a small orchestration harness.
This file documents the contract they assume, so you can read the scripts, adapt them,
or port them to your own runner. The scripts do not ship the harness itself; they are
patterns you run inside one.

A workflow is an ES module that the harness executes as a standalone script. The harness
injects a set of globals, reads an exported `meta`, and runs the module body as if it
were an async function (top-level `await` and a top-level `return` value are expected).

## What the harness injects

`args`
: The input to this run. May be an object or a JSON string, so every script starts by
  normalizing it: `let A = args; if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }`.

`log(message)`
: Progress logging, surfaced to whoever launched the run. Use it at phase boundaries and
  for counts (how many findings, how many survived), not for dumping payloads.

`agent(prompt, options)`
: Run one subagent and get its result. Returns a parsed object when you pass a `schema`,
  otherwise text. Options:
  - `label` - a short id for this call, shown in progress output.
  - `phase` - which phase this call belongs to, for grouping.
  - `schema` - a JSON schema. The harness constrains the model to return JSON matching it.
  - `model` - pin a model for this call (for example `'opus'` for a judgment step). Omit to
    use the session default.
  The agents have their own tools, including `Read`, web search, and web fetch. That is why
  a workflow can hand an agent a file path and let the agent Read the pack itself.

`parallel(fns)`
: Take an array of zero-argument functions, run them concurrently, and resolve to an array
  of their results in order. This is also a barrier: it resolves only when every function
  has settled. `judge-panel.js` relies on that barrier so scoring cannot start before all
  attempts exist.

`pipeline(items, ...stages)`
: Run each item through the stages in order. Within an item the stages are sequential; across
  items there is no barrier, so item B does not wait on item A. Use it when work items are
  independent, as in `adversarial-review.js`, where each target is reviewed on its own track.

`phase(name)`
: Mark a phase transition for progress display. Optional. Some scripts set the phase per
  `agent` call via the `phase` option instead; either works.

## What the script exports

```js
export const meta = {
  name: 'my-workflow',
  description: 'one line on what it does',
  whenToUse: 'when a skill or a human should reach for it',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Synthesize' }],
}
```

`meta.phases` drives the progress view. Each phase entry can carry a `detail` and a `model`
hint. The script then returns its result value, which the caller receives.

## Structured output

Every `agent` call that feeds a later stage passes a `schema`. Two habits make the schemas
reliable:

- Set `additionalProperties: false` on every object. A strict schema is what makes a model
  return exactly the fields you asked for and nothing extra, so the next stage can rely on
  the shape.
- Keep `required` honest. Mark a field required only if the next stage truly needs it; an
  over-strict `required` list makes the model pad rather than admit a gap.

`lib/schema.js` has a small validator and builder for this schema subset, unit-tested in
`test/schema.test.js`. An orchestrator can use it to re-check a payload itself instead of
trusting that the shape is right.

## Why the scripts are self-contained

Each workflow inlines its schemas and its pack resolver rather than importing from `lib/`.
The harness runs a workflow as a standalone script and does not resolve local imports from
the script's location, so the scripts keep everything they need in one file. The `lib/`
modules hold the tested, reusable versions of that same logic for use in an orchestrator or
in your own tooling.
