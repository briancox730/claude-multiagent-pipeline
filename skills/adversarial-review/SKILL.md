---
name: adversarial-review
description: >
  Review a code change from several angles, verify each finding independently, and
  produce one decision-grade review. Use when the user asks to review a diff, a file,
  or a changeset, or types /adversarial-review. Runs Claude Code subagents against a
  ground-truth pack passed by file reference.
---

# /adversarial-review - multi-angle review with per-finding verification

Turn a code change into a review a maintainer can act on. The work runs as a small
panel: several finders look at the same change from different angles, then every
finding they raise is re-checked by a separate agent that defaults to rejecting, then
a lead consolidates what survived into one report with a recommendation.

The point is to keep false findings out. A single reviewer pass mixes real bugs with
confident-sounding noise, and the reader has to sort them. Here the noise is filtered
before it reaches the reader, because each finding has to survive an independent check
against the actual code.

## Steps

### 1. Assemble the pack
Write the change under review to one JSON file per target under a packs directory, for
example `analysis/packs/<id>.json`. A pack holds the diff or file text plus any context
the reviewer needs. Keep the real code in the pack, not summarized - the finders reason
over exactly what is in it.

Passing the change by file reference (rather than inlining it into the workflow args)
keeps a large diff out of the orchestrator's context and reaches each agent byte for
byte. See `docs/packs-by-reference.md`.

### 2. Run the workflow
```
Workflow({ scriptPath: "workflows/adversarial-review.js",
           args: { targets: ["<id>"], packs_dir: "analysis/packs" } })
```
It returns an array of review objects, one per target. Each has a `recommendation`
(approve / approve_with_nits / request_changes / block), the surviving `findings`, and
a `dropped` list so you can see what was considered and cut.

For a tiny one-off you can inline instead: `args: { packs: { "<id>": { ...pack } } }`.

### 3. Run your own gate before you act on it
The review is agent output. Before you treat a `block` as authoritative or an `approve`
as safe, run the deterministic checks yourself: the actual test command, a secret scan,
your forbidden-string list. The agents can miss what only shows up when the code runs.

### 4. Report
Give the recommendation and the surviving findings per target, highest severity first.
Note anything in `open_questions` the panel could not settle from the pack alone.

## Guardrails
- One target is one change. Do not pack unrelated diffs together; the angles blur.
- Do not hand-write the review yourself. Run the workflow so the find / verify / synth
  separation actually happens.
- Keep `analysis/` and packs as local artifacts. They are gitignored.
