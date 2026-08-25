// "Packs by file reference" - the context-management pattern.
//
// A pack is a ground-truth payload for one work item: a diff, a spec, a data table,
// whatever the agents must reason over without contradicting. Packs are often large.
// Inlining them into the orchestrator prompt burns its context window and, worse,
// invites a transcription error when a big blob is copied into an args object.
//
// The fix: hand each agent a FILE PATH and let the agent Read its own pack. The bytes
// reach the agent exactly as written and never pass through the orchestrator's context.
// Inline mode still exists for tiny one-item runs, and inline wins when both are present.
//
// This module is pure and unit-tested in test/packs.test.js. The workflow scripts
// inline an equivalent resolver so they stay self-contained for the harness (the
// harness runs a workflow as a standalone script and does not resolve local imports).

export function normalizeArgs(args) {
  if (typeof args === 'string') {
    try { return JSON.parse(args) || {} } catch { return {} }
  }
  return args || {}
}

// resolvePacks(args) -> [{ id, mode: 'inline'|'file', data?, path? }]
// Accepts either inline `packs` (an { id: payload } map) or a `packs_dir` directory
// holding one <id>.json per item. The id list can come from `ids`, `targets`,
// or the keys of the inline map.
export function resolvePacks(args) {
  const a = normalizeArgs(args)
  const inline = a.packs || {}
  const dir = a.packs_dir || null
  const rawIds = a.ids || a.targets || Object.keys(inline)

  return rawIds
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.id))
    .filter(Boolean)
    .filter((id) => inline[id] || dir) // drop ids we have no pack for, in either mode
    .map((id) => (inline[id]
      ? { id, mode: 'inline', data: inline[id] }
      : { id, mode: 'file', path: `${dir}/${id}.json` }))
}

// packRef(entry) -> the string to splice into an agent prompt where the pack goes.
// Inline mode returns the pretty-printed JSON. File mode returns an instruction that
// tells the agent to Read the file first and treat its contents as authoritative.
export function packRef(entry) {
  if (entry.mode === 'inline') return JSON.stringify(entry.data, null, 2)
  return [
    `(READ YOUR GROUND-TRUTH PACK FIRST: use the Read tool on the file "${entry.path}".`,
    `Its JSON content IS the pack for ${entry.id}. Treat it exactly as if it were pasted`,
    `here: authoritative, never contradicted, never fabricated around.)`,
  ].join('\n')
}
