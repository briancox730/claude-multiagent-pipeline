# Examples

Sample packs and the invocations that consume them. The packs are ground-truth payloads
passed by file reference, so the workflows read them from `examples/packs/` rather than
having the content inlined into args. See `docs/packs-by-reference.md`.

These snippets show the shape of a run. Running them for real needs the workflow harness
described in `docs/harness.md`; the JSON here is what you would feed it.

## Adversarial review

`examples/packs/auth-refactor.json` is a small code change: a login rate limiter. It has a
couple of real issues planted for the finders to catch (an unbounded map, a header parsed as
if it were always a single value) and a missing test file.

```
Workflow({ scriptPath: "workflows/adversarial-review.js",
           args: { targets: ["auth-refactor"], packs_dir: "examples/packs" } })
```

Expect a review object whose `recommendation` is `request_changes`, with the surviving
findings pointing at the unbounded `buckets` map and the `x-forwarded-for` handling. The
`dropped` list should show anything a finder raised that the per-finding verifier could not
reproduce against the diff.

## Judge panel

`examples/packs/cache-strategy.json` frames an open design question with real constraints.
Pass the question directly and hand the background in by reference.

```
Workflow({ scriptPath: "workflows/judge-panel.js",
           args: { question: "HTTP-layer vs application-layer caching for a read-heavy catalog API (see context)",
                   context_path: "examples/packs/cache-strategy.json" } })
```

Expect three candidate answers from different angles, a score per candidate against the
grounding / completeness / calibration rubric, and a reconciled `final.answer` that names its
residual uncertainty (here, the 60-second freshness bound is the deciding constraint).

## Build and validate

No pack file needed; the task and its acceptance criteria are the input.

```
Workflow({ scriptPath: "workflows/build-and-validate.js",
           args: { task: "Write a pure function slugify(title) for URL slugs",
                   acceptance: [
                     "Lowercases and trims",
                     "Replaces any run of non-alphanumerics with a single hyphen",
                     "No leading or trailing hyphen",
                     "Returns empty string for input that has no alphanumerics",
                     "Has no external dependencies"
                   ],
                   max_retries: 2 } })
```

Expect a `status` of `accepted_pending_gate` on success. The name is deliberate: the agent
validator passing is not the end. The orchestrator that launched this still runs the
deterministic gate (run the function against the criteria, scan for secrets, grep forbidden
strings) before anything is accepted. See the README section on the validation gate.
