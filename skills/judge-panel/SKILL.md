---
name: judge-panel
description: >
  Answer a hard, open question with a panel: several independent attempts from
  different angles, parallel scoring against a rubric, then a synthesized answer. Use
  when the user types /judge-panel, or asks a research question where one answer is not
  trustworthy on its own. Runs Claude Code subagents.
---

# /judge-panel - independent attempts, scored, then reconciled

Use this for a question where a single confident answer is a risk. Several solvers each
answer from a different angle without seeing each other. A judge scores every candidate
against a fixed rubric. A chair reconciles the scored candidates into one answer and
says what is still open.

The independence carries the value. Three solvers that could not see each other but land
on the same claim give you real corroboration. Where they split, the split itself is a
signal that the question is genuinely contested, and the chair has to make a call rather
than paper over it.

## When this beats a single answer
- The cost of a wrong answer is high and the answer is hard to check after the fact.
- The question has more than one defensible framing.
- You want an explicit read on how much of the answer is solid versus contested.

For a quick factual lookup this is overkill. Ask directly.

## Steps

### 1. State the question and, if needed, the angles
```
Workflow({ scriptPath: "workflows/judge-panel.js",
           args: { question: "<the question>" } })
```
The default angles are first-principles, evidence-first, and devil's-advocate. Override
`angles` for a domain that wants different framings, and override `rubric` to score on
criteria that matter to you.

### 2. Pass large background by reference
If the panel needs a big shared document, put it in a file and pass `context_path` so
each solver Reads it, rather than inlining it into args. See
`docs/packs-by-reference.md`.

### 3. Read the result
The workflow returns `{ question, candidates, scores, final }`. `final.answer` is the
reconciled answer; `final.drawn_from` names which angles fed it; `final.residual_uncertainty`
is what remains open. The per-candidate `scores` show why the chair weighted things as it did.

### 4. Report
Give the final answer first, then the residual uncertainty. If the judges flagged a fatal
flaw in a candidate, mention it only if it changes what the reader should do.

## Guardrails
- More solvers is not automatically better. Three well-separated angles beat six similar ones.
- The chair runs on the strongest model on purpose. Do not downgrade it to save tokens;
  the reconciliation is the judgment step.
- Treat the answer as research, not a decision. It narrows uncertainty; it does not remove it.
