// Integration test: boot the plugin against a fake ctx and drive the tools.
// Uses the real engine and the real profile layout (read-only checks only),
// so it never depends on a running IDE or a network.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const registry = new Map()
const fakeCtx = { tools: { register: (t) => registry.set(t.name, t) } }

const results = []
try {
  apply(fakeCtx, { profile: 'desktop', cliTimeoutMs: 5000 })
  const call = async (name, args = {}) => registry.get(name).execute(args, { signal: undefined })

  // 1. all four tools registered
  results.push(['4 tools registered', ['profile_doctor', 'profile_doctor_explain', 'profile_doctor_release_age', 'profile_doctor_links'].every((n) => registry.has(n))])

  // 2. release_age works on the real profile
  const ra = await call('profile_doctor_release_age', { profile: 'desktop' })
  results.push(['release_age reports exemptions', ra.ok === true && Array.isArray(ra.exempted) && ra.exempted.length > 0])

  // 3. links check runs without throwing
  const links = await call('profile_doctor_links', { profile: 'desktop' })
  results.push(['links check returns findings array', links.ok === true && Array.isArray(links.findings)])

  // 4. full audit: the dump will fail here (no dsh CLI on PATH in this test
  //    context) — the plugin must degrade to the filesystem checks, not throw
  const audit = await call('profile_doctor', { profile: 'desktop', offline: true })
  results.push(['audit degrades gracefully', audit.ok === true && typeof audit.report === 'string'])
  results.push(['audit still found filesystem findings', Array.isArray(audit.findings)])
} catch (error) {
  console.error('UNEXPECTED THROW:', error)
  results.push(['no-throw', false])
}

let pass = 0
for (const [name, ok] of results) {
  console.log(`${ok ? '✔' : '✖'} ${name}`)
  if (ok) pass += 1
}
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
