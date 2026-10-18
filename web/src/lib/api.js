// Every request to the server leaves through this file, and site_test.mjs
// fails the build if a `fetch(` appears anywhere else under src/. The reason
// is the demo on the roadmap: once a session lives under a path prefix, a
// raw absolute call works in dev, works self-hosted, and is silently broken
// in the demo alone — the worst shape a bug can have. One chokepoint makes
// the prefix a single edit here when that day comes.

// The raw form: a Response, untouched. For the handful of calls that move
// bytes rather than JSON — snapshots, verify bundles, history replay.
export function apiFetch(path, opts = {}) {
  return fetch(path, opts)
}

// The usual form: sends JSON, parses JSON, throws Error(message) on non-2xx
// so components can catch and display it.
export async function api(path, opts = {}) {
  const res = await apiFetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}
