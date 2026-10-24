// dsh-profile-doctor engine.
//
// Part 1 (config tree) mirrors the seven checks dsh-doctor established:
// config-clobber, dead-patch, tool-collision, plugin-not-mounted,
// plugin-stale, entry-removed/toggled/added, and the area-grouped explain
// summary — same dump-and-diff approach, so an agent asking "is my config
// intact?" gets the same answers a human gets from the CLI.
//
// Part 2 (ecosystem) is what dsh-doctor does not cover, learned the hard way
// while publishing two plugins into this very profile:
//   pnpm-store-conflict      v10 store under a pnpm 11 CLI (dsh plugin add fails)
//   release-age-blocked      minimumReleaseAgeExclude gap
//   patch-name-unresolvable  patch insert name not present in node_modules
//   link-broken              junction/symlink whose target vanished
//   duplicate-capability     two mounted plugins serving the same purpose
//   orphan-backup            backup-* dirs nothing references
//   github-source            github: deps that need a live network resolve
//   publish-scope            npm token cannot publish a bare package name
//
// The dump parser is indentation-based on purpose: the dump embeds `!!js`
// expressions verbatim, which a strict YAML loader rejects and a permissive
// one would evaluate.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// =====================================================================
// Part 1: dump parsing (ported shape from dsh-doctor, same rationale)
// =====================================================================
const ENTRY_RE = /^- id:\s*(.+)$/
const KEY_RE = /^(\s*)([^\s#][^:]*):\s*(.*)$/
const LAYER_RE = /^#\s*==\s*(.+)$/

function unquote(raw) {
  const s = raw.trim()
  if (s.length >= 2 && ((s[0] === "'" && s.at(-1) === "'") || (s[0] === '"' && s.at(-1) === '"'))) return s.slice(1, -1)
  return s
}

export function parseDump(text) {
  const lines = text.split('\n')
  const entries = []
  let layer = null
  let current = null
  let path = []
  let inConfig = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const layerMatch = LAYER_RE.exec(line.trim())
    if (layerMatch) {
      layer = layerMatch[1].trim()
      continue
    }
    if (line.trimStart().startsWith('#')) continue
    const entryMatch = ENTRY_RE.exec(line)
    if (entryMatch) {
      current = { id: unquote(entryMatch[1]), name: '', disabled: false, disabledExpr: null, layer, config: new Map(), line: i + 1 }
      entries.push(current)
      path = []
      inConfig = false
      continue
    }
    if (!current) continue
    const indent = line.length - line.trimStart().length
    if (indent === 2) {
      inConfig = false
      path = []
      const m = KEY_RE.exec(line)
      if (!m) continue
      const key = m[2].trim()
      const value = m[3]
      if (key === 'name') current.name = unquote(value)
      else if (key === 'disabled') {
        const raw = unquote(value)
        if (raw.startsWith('!!js')) current.disabledExpr = raw
        else current.disabled = raw === 'true'
      } else if (key === 'config') inConfig = true
      continue
    }
    if (!inConfig || indent < 4) continue
    const trimmed = line.trimStart()
    if (trimmed.startsWith('- ')) {
      const owner = path.length ? path.map((p) => p.key).join('.') : null
      if (owner) {
        const prev = current.config.get(owner) ?? ''
        current.config.set(owner, prev ? `${prev}\n${trimmed}` : trimmed)
      }
      continue
    }
    const m = KEY_RE.exec(line)
    if (!m) continue
    const key = m[2].trim()
    const value = m[3].trim()
    while (path.length && path.at(-1).indent >= indent) path.pop()
    path.push({ indent, key })
    current.config.set(path.map((p) => p.key).join('.'), value)
  }
  return entries
}

export const byId = (entries) => new Map(entries.map((e) => [e.id, e]))

// =====================================================================
// Part 1a: the seven config checks
// =====================================================================
function shallowest(paths) {
  const sorted = [...paths].sort()
  const out = []
  for (const p of sorted) {
    if (!out.some((kept) => p === kept || p.startsWith(`${kept}.`))) out.push(p)
  }
  return out
}

export function checkClobber(composed, defaults) {
  const defaultById = byId(defaults)
  const findings = []
  for (const entry of composed) {
    const base = defaultById.get(entry.id)
    if (!base || base.config.size === 0) continue
    const missing = []
    for (const p of base.config.keys()) if (!entry.config.has(p)) missing.push(p)
    if (missing.length === 0) continue
    const restore = shallowest(missing).map((p) => ({ path: p, value: base.config.get(p) ?? '' }))
    findings.push({
      rule: 'config-clobber',
      severity: 'error',
      entry: entry.id,
      plugin: entry.name,
      title: `patch on "${entry.id}" dropped ${restore.length} default config field${restore.length > 1 ? 's' : ''}`,
      detail:
        'dsh replaces an entry\'s whole config when a patch targets it. These fields were in the shipped defaults but are missing from the tree that boots.',
      data: { dropped: restore },
      fix: `Restate them in your patch for "${entry.id}":\n` + restore.map((r) => `    ${r.path}: ${r.value}`).join('\n'),
    })
  }
  return findings
}

function distance(a, b) {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1))
      last = tmp
    }
  }
  return prev[b.length]
}

function nearest(id, live) {
  let best = null
  let bestScore = Infinity
  for (const candidate of live) {
    const d = distance(id, candidate)
    if (d < bestScore) {
      bestScore = d
      best = candidate
    }
  }
  const limit = Math.max(2, Math.floor(id.length / 3))
  return bestScore <= limit ? best : null
}

export function checkDeadPatches(composed, patchFiles) {
  const live = new Set(composed.map((e) => e.id))
  const findings = []
  for (const file of patchFiles) {
    for (const id of file.ids) {
      if (live.has(id)) continue
      const near = nearest(id, live)
      findings.push({
        rule: 'dead-patch',
        severity: 'error',
        entry: id,
        plugin: null,
        title: `patch targets "${id}", which is not in the composed tree`,
        detail: `${file.path} patches an entry id that does not exist, so dsh prints one stderr warning and boots without it.`,
        data: { file: file.path, suggestion: near },
        fix: near ? `Did you mean "${near}"? Rename the id, or delete the patch block if the plugin is gone.` : 'Delete the patch block, or reinstall the plugin that used to provide this id.',
      })
    }
  }
  return findings
}

const NAME_RE = /name\s*:\s*(['"`])([A-Za-z_][A-Za-z0-9_-]*)\1/g
const DESCRIPTION_RE = /description\s*:/
const BODY_RE = /(execute\s*[(:]|parameters\s*:)/
const NAME_WINDOW = 600
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SKIP_DIRS = new Set(['node_modules', '.bin', '.pnpm', 'test', 'tests', '__tests__'])

export function toolNamesIn(pkgDir) {
  const names = new Set()
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(join(dir, e.name), depth + 1)
        continue
      }
      if (!/\.(js|mjs|cjs)$/.test(e.name)) continue
      const p = join(dir, e.name)
      try {
        if (statSync(p).size > MAX_FILE_BYTES) continue
        const src = readFileSync(p, 'utf8')
        NAME_RE.lastIndex = 0
        let m
        while ((m = NAME_RE.exec(src))) {
          const window = src.slice(m.index, m.index + NAME_WINDOW)
          if (DESCRIPTION_RE.test(window) && BODY_RE.test(window)) names.add(m[2])
        }
      } catch {}
    }
  }
  walk(pkgDir, 0)
  return names
}

export function packagesIn(nodeModules) {
  const out = []
  let entries
  try {
    entries = readdirSync(nodeModules, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.bin' || e.name === '.pnpm') continue
    if (e.name.startsWith('@')) {
      const scope = join(nodeModules, e.name)
      let inner = []
      try {
        inner = readdirSync(scope, { withFileTypes: true })
      } catch {
        continue
      }
      for (const i of inner) if (i.isDirectory()) out.push({ name: `${e.name}/${i.name}`, dir: join(scope, i.name) })
      continue
    }
    out.push({ name: e.name, dir: join(nodeModules, e.name) })
  }
  return out
}

export function checkToolCollisions(profileDir, composed) {
  const mounted = new Set(composed.map((e) => e.name))
  const roots = [join(profileDir, 'node_modules'), join(profileDir, '..', 'node_modules')]
  const owners = new Map()
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const pkg of packagesIn(root)) {
      if (!mounted.has(pkg.name)) continue
      for (const tool of toolNamesIn(pkg.dir)) {
        if (!owners.has(tool)) owners.set(tool, new Set())
        owners.get(tool).add(pkg.name)
      }
    }
  }
  const findings = []
  for (const [tool, pkgs] of owners) {
    if (pkgs.size < 2) continue
    const list = [...pkgs].sort()
    findings.push({
      rule: 'tool-collision',
      severity: 'error',
      entry: null,
      plugin: list.join(', '),
      title: `${list.length} mounted plugins each register a tool named "${tool}"`,
      detail: 'dsh\'s registry rejects a duplicate tool name, and the boot audit turns that into a startup failure — the harness will not start while both are mounted.',
      data: { tool, packages: list },
      fix: `Disable one of them, or ask its author to register "${tool}" through an agent scope instead of globally.`,
    })
  }
  return findings
}

const isFirstParty = (name) => name.startsWith('@deepseek-ai/')

async function fetchPackageTime(name, registry, signal) {
  const url = `${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`
  const res = await fetch(url, { signal, headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (!res.ok) return null
  const json = await res.json()
  const modified = json?.time?.modified ?? json?.modified
  return modified ? new Date(modified) : null
}

export async function checkPlugins(manifest, composed, opts = {}) {
  if (!manifest) return []
  const findings = []
  const deps = Object.keys(manifest.json?.dependencies ?? {})
  const bundles = manifest.json?.dsh?.profile?.bundles ?? []
  const mountedNames = new Set(composed.map((e) => e.name))
  for (const dep of deps) {
    if (bundles.includes(dep)) continue
    if (mountedNames.has(dep)) continue
    findings.push({
      rule: 'plugin-not-mounted',
      severity: 'warn',
      entry: null,
      plugin: dep,
      title: `"${dep}" is installed but never mounted`,
      detail: 'It is a dependency of the profile, but it is neither listed in `dsh.profile.bundles` nor inserted by a patch, so nothing loads it.',
      data: {},
      fix: `Add it to dsh.profile.bundles in ${manifest.path}, or uninstall it.`,
    })
  }
  const thirdParty = deps.filter((d) => !isFirstParty(d))
  if (opts.offline || thirdParty.length === 0) return findings
  const registry = opts.registry ?? process.env.npm_config_registry ?? 'https://registry.npmjs.org'
  const now = opts.now ?? new Date()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const results = await Promise.allSettled(
      thirdParty.map(async (name) => ({ name, modified: await fetchPackageTime(name, registry, controller.signal) })),
    )
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value.modified) continue
      const days = Math.floor((now - r.value.modified) / 86_400_000)
      if (days < 180) continue
      findings.push({
        rule: 'plugin-stale',
        severity: 'warn',
        entry: null,
        plugin: r.value.name,
        title: `"${r.value.name}" has not been published in ${days} days`,
        detail: 'dsh is in developer preview and ships breaking changes; a plugin that stopped tracking it is the usual source of a tree that boots today and fails after the next upgrade.',
        data: { lastPublish: r.value.modified.toISOString(), days },
        fix: 'Check whether the project is still maintained, or pin your dsh version.',
      })
    }
  } catch {
    // Offline or blocked: staleness stays unknown, which is not an error.
  } finally {
    clearTimeout(timer)
  }
  return findings
}

export function checkToggles(composed, defaults) {
  const defaultById = byId(defaults)
  const findings = []
  for (const entry of composed) {
    const base = defaultById.get(entry.id)
    if (!base) {
      findings.push({
        rule: 'entry-added',
        severity: 'info',
        entry: entry.id,
        plugin: entry.name,
        title: `"${entry.id}" was inserted by your patch layer`,
        detail: 'This entry is not in the shipped profile; a patch `insert` added it.',
        data: {},
        fix: null,
      })
      continue
    }
    if (entry.disabledExpr || base.disabledExpr) {
      if (entry.disabledExpr !== base.disabledExpr) {
        findings.push({
          rule: 'entry-toggled',
          severity: 'info',
          entry: entry.id,
          plugin: entry.name,
          title: `"${entry.id}" enablement changed to a runtime condition`,
          detail: `Now: ${entry.disabledExpr ?? (entry.disabled ? 'disabled' : 'enabled')}. Default: ${base.disabledExpr ?? (base.disabled ? 'disabled' : 'enabled')}.`,
          data: {},
          fix: null,
        })
      }
      continue
    }
    if (entry.disabled !== base.disabled) {
      findings.push({
        rule: 'entry-toggled',
        severity: 'info',
        entry: entry.id,
        plugin: entry.name,
        title: `"${entry.id}" is ${entry.disabled ? 'disabled' : 'enabled'} by your patch layer (default: ${base.disabled ? 'disabled' : 'enabled'})`,
        detail: 'Intentional overrides are fine — this is here so the diff is visible.',
        data: {},
        fix: null,
      })
    }
  }
  for (const base of defaults) {
    if (!composed.some((e) => e.id === base.id)) {
      findings.push({
        rule: 'entry-removed',
        severity: 'warn',
        entry: base.id,
        plugin: base.name,
        title: `"${base.id}" is in the shipped profile but missing from your tree`,
        detail: 'A patch removed it. Anything depending on the service it provided will fail to resolve.',
        data: {},
        fix: null,
      })
    }
  }
  return findings
}

const AREA_LABELS = {
  client: 'Web UI', tool: 'Tools', session: 'Sessions & history', agent: 'Agent loop', llm: 'Model adapters',
  subagent: 'Subagents', skill: 'Skills', command: 'Commands', sandbox: 'Sandbox & approval', fs: 'Filesystem',
  storage: 'Storage', web: 'Web server', host: 'Host services', api: 'API gateway', compaction: 'Context compaction',
  spill: 'Context spill', goal: 'Goals', workflow: 'Workflows', workspace: 'Workspace', typert: 'Type registry',
  user: 'User interaction', cordis: 'Cordis runtime',
}

function areaOf(pkg) {
  if (pkg.startsWith('@deepseek-ai/cordis-plugin-')) return 'cordis'
  if (!pkg.startsWith('@deepseek-ai/dsh-')) return null
  return pkg.slice('@deepseek-ai/dsh-'.length).split('-')[0]
}

export function renderExplain(composed) {
  const groups = new Map()
  const thirdParty = []
  for (const e of composed) {
    const area = areaOf(e.name)
    if (area === null) {
      thirdParty.push(e)
      continue
    }
    if (!groups.has(area)) groups.set(area, [])
    groups.get(area).push(e)
  }
  const lines = []
  const total = composed.length
  const off = composed.filter((e) => e.disabled).length
  const conditional = composed.filter((e) => e.disabledExpr).length
  lines.push('')
  lines.push(`Your harness: ${total} entries, ${total - off - conditional} active, ${off} disabled${conditional ? `, ${conditional} conditional` : ''}`)
  lines.push('')
  for (const [area, entries] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const disabled = entries.filter((e) => e.disabled).length
    const label = AREA_LABELS[area] ?? area
    lines.push(`  ${label.padEnd(22)} ${String(entries.length).padStart(3)}${disabled ? `  (${disabled} off)` : ''}`)
  }
  if (thirdParty.length) {
    lines.push('')
    lines.push(`Third-party plugins (${thirdParty.length})`)
    for (const e of thirdParty) lines.push(`  ${e.id.padEnd(24)} ${e.name}${e.disabled ? '  (off)' : ''}`)
  }
  return lines.join('\n')
}

export function summarize(composed) {
  const layers = new Map()
  for (const e of composed) {
    const key = e.layer ?? '(unlabelled)'
    layers.set(key, (layers.get(key) ?? 0) + 1)
  }
  return {
    entries: composed.length,
    disabled: composed.filter((e) => e.disabled).length,
    layers: [...layers.entries()].map(([layer, count]) => ({ layer, count })),
  }
}

// =====================================================================
// Part 2: ecosystem checks (the superset dsh-doctor does not cover)
// =====================================================================
export function dshHome() {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}

function safeRead(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

function safeReaddir(p) {
  try {
    return readdirSync(p, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Parse the `minimumReleaseAgeExclude` list out of pnpm-workspace.yaml. */
export function readReleaseAgeExcludes(profileDir) {
  const text = safeRead(join(profileDir, 'pnpm-workspace.yaml'))
  if (text === null) return { file: null, entries: [] }
  const lines = text.split('\n')
  const entries = []
  let inBlock = false
  for (const line of lines) {
    if (/^\s*minimumReleaseAgeExclude:/.test(line)) {
      inBlock = true
      continue
    }
    if (inBlock) {
      const item = /^\s*-\s*(\S+)\s*$/.exec(line)
      if (item) {
        entries.push(item[1].replace(/^['"]|['"]$/g, ''))
        continue
      }
      if (line.trim() && !/^\s/.test(line)) inBlock = false
      else if (/^\s{2}\S/.test(line)) inBlock = false
    }
  }
  return { file: join(profileDir, 'pnpm-workspace.yaml'), entries }
}

/**
 * Which store the installed node_modules were linked from, and which store
 * the current pnpm would use. pnpm 11 refuses to operate on a v10 store, which
 * is exactly the `ERR_PNPM_UNEXPECTED_STORE` failure `dsh plugin add` hits.
 */
export function checkStoreConflict(profileDir) {
  const findings = []
  const nm = join(profileDir, 'node_modules')
  if (!existsSync(nm)) return findings
  const modulesYaml = safeRead(join(nm, '.modules.yaml'))
  if (modulesYaml === null) return findings
  const storeMatch = /^\s*storeDir:\s*(\S+)/m.exec(modulesYaml)
  if (!storeMatch) return findings
  const storeDir = storeMatch[1].replace(/^['"]|['"]$/g, '')
  const storeVersion = /[\\/]v(\d+)[\\/]?$/.exec(storeDir)?.[1]
  if (!storeVersion) return findings
  // The bundled CLI's pnpm decides the expected major; read it from the
  // runtime when present, else fall back to 11 (current dsh ships pnpm 11).
  let expected = '11'
  const pkgJson = safeRead(join(dshHome(), '..', '..', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'package.json'))
  if (pkgJson) {
    const v = JSON.parse(pkgJson)?.version
    if (v) expected = String(v).split('.')[0]
  }
  if (storeVersion !== expected) {
    findings.push({
      rule: 'pnpm-store-conflict',
      severity: 'error',
      entry: null,
      plugin: null,
      title: `node_modules was linked from a v${storeVersion} store, but the bundled pnpm is v${expected}`,
      detail:
        `pnpm refuses to operate across store majors, so \`dsh plugin add\` fails with ERR_PNPM_UNEXPECTED_STORE before it can change anything. ` +
        'Fix by reinstalling with the bundled pnpm, or by pointing it back at the old store with `pnpm config set store-dir <dir> --global`.',
      data: { storeDir, storeMajor: storeVersion, pnpmMajor: expected },
      fix: `pnpm config set store-dir "${storeDir}" --global   # or reinstall the profile with the bundled pnpm`,
    })
  }
  return findings
}

/**
 * A patch `insert` whose `name` does not resolve inside node_modules. This is
 * the failure mode of a hand-made junction/symlink placed at the wrong depth
 * (a scoped package must sit under node_modules/@scope/, not node_modules/).
 */
/**
 * The id-targeted patch files that make up the user layer, in the order dsh
 * applies them (profile first, then home — the later one outranks). Each row
 * records both the `id` fields and any `insert` blocks (id + name), because
 * the ecosystem checks need the insert names to test resolvability.
 *
 * An insert child sits deeper than a top-level entry: `- insert:` introduces
 * a sequence whose items are indented, so `id` at indent >= 4 belongs to an
 * insert, while `- id:` at column 0 is a top-level patch row. Relying on
 * indentation (not on the literal `insert:` line) also survives the common
 * hand-edit where the `insert:` header is dropped entirely.
 */
export function readUserPatches(profile) {
  const home = dshHome()
  const candidates = [join(home, 'profiles', profile, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]
  const out = []
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const text = safeRead(path)
    if (text === null) continue
    const ids = []
    const inserts = []
    let insertDepth = null // indent of an open `- insert:` sequence
    let current = null
    for (const line of text.split('\n')) {
      const idMatch = /^(\s*)-\s*id:\s*(.+?)\s*$/.exec(line)
      if (idMatch) {
        const indent = idMatch[1].length
        const id = idMatch[2].replace(/^['"]|['"]$/g, '')
        const isInsertChild = insertDepth !== null && indent >= insertDepth
        if (isInsertChild) {
          ids.push(id)
          current = { id, insert: true }
        } else {
          insertDepth = null
          ids.push(id)
          current = { id, insert: false }
        }
        continue
      }
      const insertMatch = /^(\s*)-?\s*insert:\s*$/.exec(line)
      if (insertMatch) {
        // children of this sequence sit at least 2 spaces deeper than `insert:`
        insertDepth = insertMatch[1].length + 2
        continue
      }
      const nameMatch = /^\s*name:\s*(.+?)\s*$/.exec(line)
      if (nameMatch && current && current.insert) {
        inserts.push({ id: current.id, name: nameMatch[1].replace(/^['"]|['"]$/g, '') })
        current = null
      }
      // a top-level field (indent 2, no dash) closes the insert sequence
      if (/^\s{2}\S/.test(line) && !/^\s*-/.test(line)) insertDepth = null
    }
    out.push({ path, ids, inserts })
  }
  return out
}

/** The profile's own package.json. */
export function readProfileManifest(profile) {
  const path = join(dshHome(), 'profiles', profile, 'package.json')
  if (!existsSync(path)) return null
  const text = safeRead(path)
  if (text === null) return null
  try {
    return { path, json: JSON.parse(text) }
  } catch {
    return null
  }
}

/** Plugin descriptions keyed by package name, for the capability heuristic. */
export function readDescriptions(profileDir) {
  const out = new Map()
  const roots = [join(profileDir, 'node_modules'), join(profileDir, '..', 'node_modules')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const pkg of packagesIn(root)) {
      const pkgJson = safeRead(join(pkg.dir, 'package.json'))
      if (pkgJson === null) continue
      try {
        const json = JSON.parse(pkgJson)
        out.set(pkg.name, `${json.description || ''} ${json.keywords?.join(' ') || ''}`)
      } catch {}
    }
  }
  return out
}

/**
 * Capture both config dumps. `--dump-config` renders the tree that boots;
 * `--dump-default-config` renders the same tree without the user layer, which
 * is what makes an attribution to the user's own patch possible.
 */
export async function captureDumps(profile, opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const local = join(cwd, 'node_modules', '.bin', 'dsh')
  const bin = existsSync(local) ? { cmd: local, args: [] } : { cmd: 'dsh', args: [] }
  const base = ['--profile', profile]
  const exec = async (flag) => {
    const { stdout } = await run(bin.cmd, [...bin.args, ...base, flag], {
      cwd,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    })
    return stdout
  }
  // Sequential on purpose: dsh writes into the profile directory on first use
  // (template init, module fallback healing), and two concurrent boots race.
  const composed = await exec('--dump-config')
  const dflt = await exec('--dump-default-config')
  return { composed, default: dflt }
}

export function checkPatchNames(profileDir, patchFiles) {
  const findings = []
  const roots = [join(profileDir, 'node_modules'), join(profileDir, '..', 'node_modules')]
  const resolveName = (name) => {
    const rel = name.startsWith('@') ? name.split('/').join('/') : name
    for (const root of roots) {
      if (existsSync(join(root, rel, 'package.json'))) return true
      // a junction/symlink dir still has a package.json through it
      if (existsSync(join(root, rel))) return true
    }
    return false
  }
  for (const file of patchFiles) {
    for (const insert of file.inserts ?? []) {
      if (resolveName(insert.name)) continue
      findings.push({
        rule: 'patch-name-unresolvable',
        severity: 'error',
        entry: insert.id,
        plugin: insert.name,
        title: `patch insert "${insert.id}" names "${insert.name}", which node_modules cannot resolve`,
        detail:
          `${file.path} asks the loader to mount ${insert.name}, but no such directory exists under the profile's node_modules. ` +
          'A scoped package must live at node_modules/@scope/name (a junction at node_modules/name will not be found).',
        data: { file: file.path, name: insert.name },
        fix: `Place the package at node_modules/${insert.name} (creating @scope/ when it is scoped), or remove the patch row.`,
      })
    }
  }
  return findings
}

/** Junction/symlink entries in node_modules whose target no longer exists. */
export function checkBrokenLinks(profileDir) {
  const findings = []
  const roots = [join(profileDir, 'node_modules'), join(profileDir, '..', 'node_modules')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const e of safeReaddir(root)) {
      // A broken junction reports isSymbolicLink()=true / isDirectory()=false
      // from readdir, so filtering on isDirectory() would skip exactly the
      // entries this check exists to find. Inspect every directory-looking
      // entry and let inspectLink decide.
      if (e.isSymbolicLink && e.isSymbolicLink()) {
        inspectLink(join(root, e.name), e.name, findings)
        continue
      }
      if (!e.isDirectory()) continue
      if (e.name.startsWith('@')) {
        for (const inner of safeReaddir(join(root, e.name))) {
          if (inner.isSymbolicLink && inner.isSymbolicLink()) {
            inspectLink(join(root, e.name, inner.name), `${e.name}/${inner.name}`, findings)
            continue
          }
          if (!inner.isDirectory()) continue
          inspectLink(join(root, e.name, inner.name), `${e.name}/${inner.name}`, findings)
        }
        continue
      }
      inspectLink(join(root, e.name), e.name, findings)
    }
  }
  return findings
}

function inspectLink(dir, label, findings) {
  // A junction whose target is gone fails lstat outright on Windows — that is
  // itself the broken-link signal, so an error here is reported, not skipped.
  let st = null
  try {
    st = lstatSync(dir)
  } catch {
    findings.push({
      rule: 'link-broken',
      severity: 'error',
      entry: null,
      plugin: label,
      title: `"${label}" cannot be read (broken junction or permissions)`,
      detail: 'The entry exists in the directory listing but stat fails on it, which on Windows means a junction whose target no longer exists.',
      data: { path: dir },
      fix: `Remove node_modules/${label} and reinstall the package, or recreate the link.`,
    })
    return
  }
  const isLink = st.isSymbolicLink()
  // A junction reports as a directory through lstat (Node does not surface the
  // reparse point), so detect it by following the path: a junction resolves
  // through realpathSync while lstat says plain directory.
  let junction = false
  if (!isLink && st.isDirectory()) {
    try {
      junction = realpathSync(dir) !== dir
    } catch {}
  }
  if (!isLink && !junction) return
  let targetOk = false
  try {
    const real = realpathSync(dir)
    targetOk = Boolean(real) && existsSync(join(real, 'package.json'))
  } catch {}
  if (targetOk) return
  findings.push({
    rule: 'link-broken',
    severity: 'error',
    entry: null,
    plugin: label,
    title: `"${label}" is a link whose target is missing or not a package`,
    detail: 'The directory is a junction or symlink, but its target is gone or has no package.json. dsh fails to resolve it at boot.',
    data: { path: dir },
    fix: `Recreate the link, or remove node_modules/${label} and reinstall the package.`,
  })
}

/**
 * Two mounted plugins that serve the same purpose. Keyword overlap over their
 * descriptions is a heuristic, so it is reported as a hint (warn), never as an
 * error: the user knows whether they run both on purpose.
 */
const CAPABILITY_WORDS = [
  ['code-review', /code.?review|代码评审|代码审查|review.*diff|diff.*review/i],
  ['memory', /长期记忆|跨会话记忆|memory.*persist|persistent.*memory/i],
  ['web-search', /web.?search|联网搜索|search.*web/i],
  ['vision', /识图|视觉|vision|ocr|image.*understand/i],
  ['browser', /浏览器控制|browser.?control|computer.?use|桌面控制/i],
  ['git', /git.*panel|git.*管理|提交.*推送|branch.*manage/i],
  ['notes', /便签|笔记|sticky.?note|notebook/i],
  ['todo', /待办|todo|task.?list|任务清单/i],
  ['screenshot', /截屏|截图|screenshot/i],
]

export function checkDuplicateCapabilities(entries, descriptions) {
  const findings = []
  for (const [label, re] of CAPABILITY_WORDS) {
    const matches = entries.filter((e) => re.test(descriptions.get(e.name) || ''))
    const names = [...new Set(matches.map((e) => e.name))].filter((n) => !isFirstParty(n))
    if (names.length < 2) continue
    findings.push({
      rule: 'duplicate-capability',
      severity: 'warn',
      entry: null,
      plugin: names.join(', '),
      title: `${names.length} third-party plugins all provide "${label}"`,
      detail:
        'Overlapping capabilities cost memory and startup time, and make it unclear which one a tool call went to. Running both on purpose is fine — this is a hint, not an error.',
      data: { capability: label, packages: names },
      fix: 'If you did not mean to run both, disable one in your profile patch (disabled: true) or uninstall it.',
    })
  }
  return findings
}

/** backup-* directories nothing in the tree references. */
export function checkOrphanBackups(profileDir) {
  const findings = []
  const dsh = dshHome()
  if (!existsSync(dsh)) return findings
  const referenced = new Set()
  for (const e of safeReaddir(join(dsh, 'profiles'))) {
    if (!e.isDirectory()) continue
    const manifest = safeRead(join(dsh, 'profiles', e.name, 'package.json'))
    if (manifest) {
      for (const m of manifest.matchAll(/backup-[A-Za-z0-9._-]+/g)) referenced.add(m[0])
    }
  }
  for (const e of safeReaddir(dsh)) {
    if (!e.isDirectory() || !/^backup-/.test(e.name)) continue
    if (referenced.has(e.name)) continue
    let size = 0
    let files = 0
    const walk = (dir, depth) => {
      if (depth > 4) return
      for (const item of safeReaddir(dir)) {
        const full = join(dir, item.name)
        if (item.isDirectory()) {
          walk(full, depth + 1)
          continue
        }
        try {
          size += statSync(full).size
          files += 1
        } catch {}
      }
    }
    walk(join(dsh, e.name), 0)
    findings.push({
      rule: 'orphan-backup',
      severity: 'warn',
      entry: null,
      plugin: e.name,
      title: `"${e.name}" is a backup directory nothing references (${(size / 1024).toFixed(0)} KB, ${files} files)`,
      detail: 'Plugin managers leave these behind after upgrades. They are inert, but they accumulate and hide the directory you are looking for.',
      data: { name: e.name, bytes: size, files },
      fix: `Delete it when you no longer need the rollback point: Remove-Item "${join(dsh, e.name)}" -Recurse`,
    })
  }
  return findings
}

/** github: dependencies need a live network resolve and break offline. */
export function checkGithubSources(manifest) {
  if (!manifest) return []
  const deps = manifest.json?.dependencies ?? {}
  const findings = []
  for (const [name, spec] of Object.entries(deps)) {
    const s = String(spec)
    if (!/^(github:|git\+|https:\/\/github\.com\/|git:)/.test(s)) continue
    findings.push({
      rule: 'github-source',
      severity: 'warn',
      entry: null,
      plugin: name,
      title: `"${name}" installs from ${s.split(':')[0]}: instead of the npm registry`,
      detail:
        'A git source resolves against the live repository, so an install can move under you (a force-push changes what you get), it needs network access where the registry might be mirrored, and it bypasses the registry integrity checks.',
      data: { name, spec: s },
      fix: 'Prefer a published npm version when the author ships one; otherwise pin an exact commit or tag.',
    })
  }
  return findings
}

/**
 * A bare (unscoped) npm name cannot be published by a granular token that is
 * scoped to an owner — the registry answers 403 on the PUT. Detecting it here
 * saves the failed publish, not the publish itself.
 */
export function checkPublishScope(profileDir) {
  const findings = []
  const manifest = safeRead(join(profileDir, 'package.json'))
  if (!manifest) return findings
  let json
  try {
    json = JSON.parse(manifest)
  } catch {
    return findings
  }
  const npmrc = safeRead(join(homedir(), '.npmrc'))
  const hasToken = npmrc ? /_authToken\s*=/.test(npmrc) : false
  const tokenScope = npmrc ? /\/\/registry\.npmjsorg\/?:_authToken/.test(npmrc.replace(/\s/g, '')) : false
  const github = Object.entries(json.dependencies ?? {}).filter(([, spec]) => String(spec).startsWith('github:'))
  if (github.length && hasToken) {
    findings.push({
      rule: 'publish-scope',
      severity: 'info',
      entry: null,
      plugin: null,
      title: `this profile installs ${github.length} package(s) from GitHub sources`,
      detail:
        'Publishing to the market usually means an npm release first. A granular token scoped to an owner cannot publish a bare package name — the registry answers 403 E403 on the PUT — so a scoped name (@owner/pkg) is the reliable route.',
      data: { githubSources: github.map(([n]) => n), tokenScope },
      fix: 'If a publish fails with E403, publish under a scoped name (@owner/pkg) or generate a token with publish rights for the bare name.',
    })
  }
  return findings
}

