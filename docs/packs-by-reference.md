# Packs by file reference

A pack is the ground-truth payload for one work item: the diff under review, the spec to
build against, the background a research panel must not contradict. Packs are usually large
and they are the thing everything else has to stay faithful to.

There are two ways to get a pack to the agents. One of them scales and one does not.

## The problem with inlining

The obvious move is to put the pack straight into the workflow args:

```
args: { packs: { "auth-refactor": { diff: "<8 KB of diff text>", context: "..." } } }
```

Two things go wrong as the pack grows.

First, the pack now sits in the orchestrator's context. The orchestrator is the thing
holding the whole run together, and its context is the scarcest resource in a long
multi-agent job. Spending it on payload the orchestrator never reads itself is waste, and
several large packs at once can crowd out the state the orchestrator actually needs.

Second, and worse, inlining invites a transcription error. Whenever a large blob gets
copied into an args object by hand or by a step in between, one wrong character can slip
into the ground truth. Now every agent reasons faithfully over a corrupted pack, and the
error is silent because the numbers still look plausible. The whole point of a pack is that
it is authoritative, so a quiet edit to it is the most damaging bug in the pipeline.

## The pattern

Write one pack file per item and pass the directory. Each agent Reads its own pack.

```
args: { targets: ["auth-refactor"], packs_dir: "analysis/packs" }
```

The workflow, for each agent prompt, splices in an instruction instead of the payload:

```
(READ YOUR PACK FIRST: use the Read tool on the file "analysis/packs/auth-refactor.json".
 Its JSON content IS the change under review. Treat it as authoritative.)
```

The bytes reach the agent exactly as written. They never pass through the orchestrator's
context, and nothing between the source and the agent gets a chance to retype them. Inline
mode still exists for a tiny one-item run, and inline wins when both are present, but the
file-reference path is the default for anything real.

## In this repo

- `lib/packs.js` has `resolvePacks(args)` and `packRef(entry)`, the two-mode resolver,
  unit-tested in `test/packs.test.js`.
- `workflows/adversarial-review.js` uses the pattern: the diff is the pack, passed by path.
- `workflows/judge-panel.js` and `workflows/build-and-validate.js` take an optional
  `context_path` for the same reason - large shared background goes in a file.
- `examples/packs/` holds sample packs you can point a workflow at.

## When to still inline

Inline is fine when the pack is small and the run is a one-off you are typing by hand. The
line is roughly whether you would be comfortable pasting the payload into a chat message. If
it is a paragraph of context, inline it. If it is a diff, a table, or a document, put it in a
file.
