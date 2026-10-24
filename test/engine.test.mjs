import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  byId,
  checkBrokenLinks,
  checkClobber,
  checkDeadPatches,
  checkDuplicateCapabilities,
  checkGithubSources,
  checkOrphanBackups,
  checkPatchNames,
  checkStoreConflict,
  checkToggles,
  checkToolCollisions,
  parseDump,
  readReleaseAgeExcludes,
  renderExplain,
  summarize,
} from '../lib/engine.js'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

// a realistic dump excerpt: entries, a !!js expression, a config subtree,
// a sequence item, and a layer comment
const DUMP = `# == bundle: @deepseek-ai/dsh-base
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  disabled: false
  config:
    provider: bupt
    model: deepseek-v4-flash
    reasoningEffort: high
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  disabled: false
  config:
    providers:
      cometapi:
        baseURL: https://api.cometapi.com/v1
        apiKeyEnv: COMETAPI_API_KEY
    defaultProvider: cometapi
# == patch: profile cordis.patch.yml
- id: session-title
  name: "@deepseek-ai/dsh-session-title"
  disabled: !!js process.platform === 'win32'
  config:
    fallbackMaxWords: 12
- id: page-monitor
  name: "@bushizhanghan/dsh-page-monitor"
  disabled: false
  config:
    intervalMinutes: 60
    keywords:
      - 通知
      - 公告
`

test('parseDump reads ids, names, disabled, config paths and layers', () => {
  const entries = parseDump(DUMP)
  assert.equal(entries.length, 4)
  const byid = byId(entries)
  assert.equal(byid.get('agent-default-model').name, '@deepseek-ai/dsh-agent-default-model')
  assert.equal(byid.get('agent-default-model').config.get('provider'), 'bupt')
  // nested paths
  assert.equal(byid.get('llm-pi-ai').config.get('providers.cometapi.baseURL'), 'https://api.cometapi.com/v1')
  assert.equal(byid.get('llm-pi-ai').config.get('defaultProvider'), 'cometapi')
  // !!js is recorded, never evaluated
  assert.equal(byid.get('session-title').disabled, false)
  assert.equal(byid.get('session-title').disabledExpr, "!!js process.platform === 'win32'")
  // sequence items attach to their owner key
  assert.match(byid.get('page-monitor').config.get('keywords') || '', /通知/)
  // layer provenance
  assert.equal(byid.get('page-monitor').layer, 'patch: profile cordis.patch.yml')
})

test('summarize counts entries, disabled and layers', () => {
  const s = summarize(parseDump(DUMP))
  assert.equal(s.entries, 4)
  assert.equal(s.disabled, 0)
  assert.ok(s.layers.some((l) => l.layer.includes('dsh-base')))
})

test('checkClobber finds fields the user patch dropped', () => {
  const defaults = parseDump(
    `- id: session-title
  name: "@deepseek-ai/dsh-session-title"
  disabled: false
  config:
    fallbackMaxWords: 12
    fallbackMaxBytes: 40
    maxTitleBytes: 80
`,
  )
  const composed = parseDump(
    `- id: session-title
  name: "@deepseek-ai/dsh-session-title"
  disabled: false
  config:
    fallbackMaxWords: 12
`,
  )
  const findings = checkClobber(composed, defaults)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'config-clobber')
  assert.equal(findings[0].severity, 'error')
  const paths = findings[0].data.dropped.map((d) => d.path)
  assert.ok(paths.includes('fallbackMaxBytes'))
  assert.ok(paths.includes('maxTitleBytes'))
  assert.ok(findings[0].fix.includes('fallbackMaxBytes: 40'))
})

test('checkClobber stays quiet when nothing was dropped', () => {
  const dump = `- id: a\n  name: "a"\n  config:\n    x: 1\n`
  assert.deepEqual(checkClobber(parseDump(dump), parseDump(dump)), [])
})

test('checkDeadPatches flags a dead id and suggests the near one', () => {
  const composed = parseDump(`- id: agent-default-model\n  name: "x"\n`)
  const patches = [{ path: '/tmp/patch.yml', ids: ['agent-defualt-model', 'totally-unrelated-id'] }]
  const findings = checkDeadPatches(composed, patches)
  assert.equal(findings.length, 2)
  const typo = findings.find((f) => f.entry === 'agent-defualt-model')
  assert.equal(typo.data.suggestion, 'agent-default-model')
  assert.match(typo.fix, /Did you mean/)
  const unrelated = findings.find((f) => f.entry === 'totally-unrelated-id')
  assert.equal(unrelated.data.suggestion, null)
})

test('checkToggles reports added/removed/toggled', () => {
  const defaults = parseDump(
    `- id: a\n  name: "a"\n  disabled: false\n- id: b\n  name: "b"\n  disabled: false\n`,
  )
  const composed = parseDump(
    `- id: a\n  name: "a"\n  disabled: true\n- id: c\n  name: "c"\n  disabled: false\n`,
  )
  const rules = checkToggles(composed, defaults).map((f) => f.rule).sort()
  assert.deepEqual(rules, ['entry-added', 'entry-removed', 'entry-toggled'])
})

test('checkToolCollisions finds two packages registering one tool name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-tools-'))
  try {
    const nm = join(dir, 'node_modules')
    mkdirSync(join(nm, 'pkg-a'), { recursive: true })
    mkdirSync(join(nm, 'pkg-b'), { recursive: true })
    writeFileSync(join(nm, 'pkg-a', 'package.json'), JSON.stringify({ name: 'pkg-a' }))
    writeFileSync(join(nm, 'pkg-b', 'package.json'), JSON.stringify({ name: 'pkg-b' }))
    const src = `export default { name: 'search', description: 'd', parameters: {}, async execute() {} }`
    writeFileSync(join(nm, 'pkg-a', 'index.js'), src)
    writeFileSync(join(nm, 'pkg-b', 'index.js'), src)
    const composed = parseDump(`- id: a\n  name: "pkg-a"\n- id: b\n  name: "pkg-b"\n`)
    const findings = checkToolCollisions(dir, composed)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule, 'tool-collision')
    assert.equal(findings[0].severity, 'error')
    assert.deepEqual(findings[0].data.packages, ['pkg-a', 'pkg-b'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPatchNames flags an insert whose package is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-patch-'))
  try {
    const patches = [{ path: '/tmp/cordis.patch.yml', ids: ['page-monitor'], inserts: [{ id: 'page-monitor', name: '@bushizhanghan/dsh-page-monitor' }] }]
    const findings = checkPatchNames(dir, patches)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule, 'patch-name-unresolvable')
    assert.match(findings[0].fix, /node_modules\/@bushizhanghan\/dsh-page-monitor/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkStoreConflict flags a v10 store under pnpm 11', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-store-'))
  try {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.modules.yaml'), 'storeDir: C:/Users/1/AppData/Local/pnpm/store/v10\n')
    const findings = checkStoreConflict(dir)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule, 'pnpm-store-conflict')
    assert.equal(findings[0].data.storeMajor, '10')
    assert.match(findings[0].fix, /store-dir/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkStoreConflict stays quiet on a matching store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-store-ok-'))
  try {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.modules.yaml'), 'storeDir: C:/Users/1/AppData/Local/pnpm/store/v11\n')
    assert.deepEqual(checkStoreConflict(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkBrokenLinks flags a junction to a vanished target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-link-'))
  try {
    const nm = join(dir, 'node_modules')
    mkdirSync(nm, { recursive: true })
    // a real dir with package.json is not a link -> quiet
    mkdirSync(join(nm, 'good'), { recursive: true })
    writeFileSync(join(nm, 'good', 'package.json'), '{}')
    // a junction to a missing target
    cmdJunction(join(nm, 'broken'), join(dir, 'gone'))
    const findings = checkBrokenLinks(dir)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule, 'link-broken')
    assert.equal(findings[0].plugin, 'broken')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function cmdJunction(link, target) {
  execSync(`cmd /c mklink /J "${link}" "${target}"`, { stdio: 'ignore' })
}

test('checkDuplicateCapabilities flags two plugins serving one purpose', () => {
  const composed = parseDump(`- id: a\n  name: "@x/dsh-code-review"\n- id: b\n  name: "@y/dsh-code-review"\n- id: c\n  name: "@z/dsh-other"\n`)
  const descriptions = new Map([
    ['@x/dsh-code-review', 'code review for diffs'],
    ['@y/dsh-code-review', '代码评审与 diff 审查'],
    ['@z/dsh-other', 'unrelated thing'],
  ])
  const findings = checkDuplicateCapabilities(composed, descriptions)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'duplicate-capability')
  assert.equal(findings[0].severity, 'warn')
  assert.deepEqual(findings[0].data.packages, ['@x/dsh-code-review', '@y/dsh-code-review'])
})

test('checkGithubSources flags git-sourced deps', () => {
  const manifest = { path: '/tmp/package.json', json: { dependencies: { 'a': '^1.0.0', 'b': 'github:user/repo' } } }
  const findings = checkGithubSources(manifest)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].plugin, 'b')
})

test('readReleaseAgeExcludes parses the workspace list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-ra-'))
  try {
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      `packages:\n  - .\nminimumReleaseAgeExclude:\n  - 'dshmarket@1.66.28'\n  - "@liustack/modlens@3.27.1"\nallowBuilds:\n  koffi: false\n`,
    )
    const policy = readReleaseAgeExcludes(dir)
    assert.deepEqual(policy.entries, ['dshmarket@1.66.28', '@liustack/modlens@3.27.1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderExplain groups by area and lists third-party plugins', () => {
  const composed = parseDump(
    `- id: session-title\n  name: "@deepseek-ai/dsh-session-title"\n- id: llm-x\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n- id: mine\n  name: "@bushizhanghan/dsh-page-monitor"\n`,
  )
  const text = renderExplain(composed)
  assert.match(text, /Sessions & history/)
  assert.match(text, /Model adapters/)
  assert.match(text, /Third-party plugins \(1\)/)
  assert.match(text, /@bushizhanghan\/dsh-page-monitor/)
})

test('checkOrphanBackups reports a backup dir nothing references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-bak-'))
  try {
    mkdirSync(join(dir, 'backup-plugin-upgrade-20261022'), { recursive: true })
    writeFileSync(join(dir, 'backup-plugin-upgrade-20261022', 'x.js'), 'x')
    const real = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const findings = checkOrphanBackups(join(dir, 'profiles', 'desktop'))
      assert.equal(findings.length, 1)
      assert.equal(findings[0].rule, 'orphan-backup')
    } finally {
      if (real === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = real
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
