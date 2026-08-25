# claude-multiagent-pipeline

Runnable patterns for orchestrating Claude Code agents, plus the delegation methodology
that makes the output trustworthy. The workflows show the mechanics: fan out to
independent agents, verify each other's work adversarially, and reconcile the results
under a strict output schema. The methodology, in the section below, is the part that
matters more: how an orchestrator hands work to agents and then refuses to trust the
result until it has checked it independently.

This is a template repo. The domains here are code review and research because they are
generic. The shapes are what you copy.

## What is in here

- `workflows/` - three orchestration scripts you can read top to bottom. Each is
  self-contained and commented with why it is built the way it is.
- `lib/` - the reusable, unit-tested pieces an orchestrator uses: a schema validator, the
  pack resolver, and the validation-gate logic.
- `skills/` - two `SKILL.md` files showing how a skill wraps a workflow so a human can
  invoke it by name.
- `docs/` - the harness contract the scripts are written against, and the packs-by-reference
  pattern in full.
- `examples/` - sample packs and the invocations that consume them.
- `test/` - `node:test` suites for everything in `lib/`.

## The three workflows

**Adversarial review** (`workflows/adversarial-review.js`). Several finders look at one
code change from different angles. Every finding they raise is then re-checked by a
separate agent that defaults to rejecting, and only the survivors reach the final report.
The verify step is per finding and independent, so a confident-sounding batch cannot carry
a weak claim through on the strength of its neighbors.

**Judge panel** (`workflows/judge-panel.js`). N solvers answer a hard question from
different angles without seeing each other. A judge scores every candidate against a
rubric, and a chair reconciles them into one answer that names what is still open. The
value is the independence: agreement between solvers that could not see each other means
something, and disagreement is a signal rather than noise.

**Build and validate** (`workflows/build-and-validate.js`). A builder produces an artifact
against acceptance criteria written up front. An independent validator checks the artifact
itself, not the builder's self-report. On failure the loop retries with the specific
failures as feedback, capped, then escalates to a human. This one encodes the methodology
below directly in code.

### Pipeline or barrier: why they differ

The two composition primitives look similar and are not interchangeable.

Adversarial review runs its targets through a **pipeline**. Each target flows find to
verify to synthesize on its own track, and reviewing target B never needs target A's
result. A pipeline is right here because the work items are independent, so nothing should
wait on anything else.

The judge panel needs a **barrier**. Scoring compares each candidate partly by how it
stands against the others, and the chair needs the whole slate before it can reconcile.
So the panel gathers every attempt with `parallel`, which resolves only when all of them
are done, and only then starts scoring. A pipeline would let the first candidate race
ahead to scoring before the last one exists, which defeats the comparison. Picking the
wrong one of these does not throw an error. It quietly produces worse judgments, which is
exactly the kind of failure the methodology below is built to catch.

## Packs by file reference

Agents receive a file path to their ground-truth payload and Read it themselves, instead
of having the content pasted into the orchestrator's args. This keeps a large diff or
document out of the orchestrator's scarce context, and it removes the step where a big
blob gets retyped into an args object and one wrong character corrupts the ground truth
for every agent downstream. `docs/packs-by-reference.md` has the full pattern, and
`lib/packs.js` is the tested resolver.

## The delegation methodology

The workflows are the easy part. The hard part is trusting what comes back. An agent that
finishes a task and reports success is giving you its own account of its own work, produced
by the same process that did the work. That account feels right for the same reason the
work felt right to it, so it is not evidence. The methodology exists to replace that account
with checks the orchestrator runs itself.

### Scoped briefs with acceptance checks baked in

Each agent gets one task with a clear boundary and the acceptance criteria stated before it
starts. Not "improve the login flow" but "add a per-IP rate limiter to POST /login; it must
return 429 past the limit, must not leak memory across distinct IPs, and must ship with a
test." The criteria are written first because the builder and the validator both work to
the same bar, and because a criterion you cannot state up front is one you cannot check
later. Scope is a feature. A narrow brief with sharp acceptance checks gets a better result
than a broad brief with a vague one.

### The independent validation gate

When an agent reports done, the orchestrator runs its own checks before accepting anything.
The checks have to be things the orchestrator can run deterministically, not another agent's
opinion:

- Re-run the actual test command. Do not read the agent's claim that tests pass; run them and
  watch them pass.
- Scan the real git history for secrets, not just the working tree. A key committed and then
  removed in a later commit is still in the history and still leaked.
- Grep for the project's forbidden strings: internal names, private hostnames, anything that
  must not ship.
- Run the build.

`lib/gate.js` holds the pure parts of this: a forbidden-string and secret scanner, a gate
evaluator, and the retry-decision logic. The parts that touch the world - running git,
running the test command - belong in the orchestrator, which is why they are not in the
library. The point of the gate is that it is a route to the truth that is independent of the
route the agent took, so it can catch what the agent's own checks structurally could not.

### Two failures this gate catches

These are anonymized from real runs. Both passed the agent's own checks and both were caught
only because the orchestrator checked independently.

**A deprecated API endpoint that the agent's tests could not see.** An agent was asked to add
a client for a third-party service and it wrote the client against an endpoint that had been
deprecated and removed. Its unit tests mocked the HTTP layer, so the mock happily returned a
success for the dead path, and the tests passed offline. The agent reported green and it was
telling the truth about its tests. The gate caught it by exercising the integration once for
real, which returned a 404. Green tests verify the tests. They do not verify the world, and
an offline mock cannot know that a path stopped existing.

**A commit attributed to the wrong identity.** An agent finished a change and committed it
with an author email that did not match the required identity - a plain address where the
project's GitHub noreply form was required. The diff was correct, the tests passed, and the
commit looked completely normal. Authorship is not in the diff and not in the test output,
so nothing the agent could check would have surfaced it. The gate caught it by comparing the
`git log` author against the required identity before any push. A one-line metadata check
found what a full test suite never would.

### Retry with specific feedback, capped, then escalate

A failed gate does not mean start over blind. The orchestrator hands the next attempt the
exact failures, so it fixes the named problem instead of guessing. Vague retries reproduce
the same miss; specific ones do not. The retries are capped, at two by default. After that
the orchestrator stops and escalates to a human with a short handoff: the task, the
acceptance criteria, and the failures that would not resolve. An agent that has missed the
same bar three times is not going to get it on the fourth, and burning tokens on a fourth try
is worse than surfacing the problem. `lib/gate.js` has `retryDecision`, and
`workflows/build-and-validate.js` runs the loop end to end.

### Staged publication

Nothing an agent panel produced goes straight to a public remote. The path is private first,
then a human reads it, then it goes public. Push to a private branch or repo, review it with
human eyes, and only then promote it. The independent gate runs before the private push, so
by the time a human is reading, the mechanical failures are already out. What is left for the
human is judgment, which is the thing worth a human's time. This repo itself was built that
way: a fresh git history with a pinned identity, a scan for forbidden strings across every
file, and no remote until a person had looked.

## Running the tests

```
node --test
```

The suites in `test/` cover the schema validator, the pack resolver, and the gate logic. They
run offline with no dependencies. Node 20 or newer.

What is not unit-tested here, and honestly cannot be, is the orchestration inside the workflow
scripts. Those need the live harness and live agents to run, so they are validated by running
them, not by unit tests. The pure logic they lean on is extracted into `lib/` and tested there,
and the scripts themselves are checked for syntax against the harness's execution shape. The
split is deliberate: unit-test the pure pieces, integration-test the orchestration by running it.

## Repo layout

```
workflows/     adversarial-review.js, judge-panel.js, build-and-validate.js
lib/           schema.js, packs.js, gate.js
skills/        adversarial-review/SKILL.md, judge-panel/SKILL.md
docs/          harness.md, packs-by-reference.md
examples/      README.md, packs/
test/          schema.test.js, packs.test.js, gate.test.js
```

## License

MIT. See `LICENSE`.
