// dsh-profile-doctor: agent tools over the profile audit pipeline.
//
// The same check pipeline backs the tools an agent calls and the report a
// human reads, so "is my own config intact?" gets one answer, not two that
// drift. Every check is read-only: this plugin never writes to your profile.
import { join } from 'node:path'
import {
  byId,
  captureDumps,
  checkBrokenLinks,
  checkClobber,
  checkDeadPatches,
  checkDuplicateCapabilities,
  checkGithubSources,
  checkOrphanBackups,
  checkPatchNames,
  checkPlugins,
  checkPublishScope,
  checkStoreConflict,
  checkToggles,
  checkToolCollisions,
  dshHome,
  parseDump,
  readDescriptions,
  readProfileManifest,
  readReleaseAgeExcludes,
  readUserPatches,
  renderExplain,
  summarize,
} from './engine.js'

export const name = 'profile-doctor'
export const inject = ['tools']

const Config = {
  // Default profile to audit when a tool is called without one.
  profile: 'desktop',
  // Registry reachability: a blocked registry downgrades staleness to unknown
  // rather than failing the run, because a doctor that dies behind a firewall
  // is worse than one that reports less.
  offline: false,
  cliTimeoutMs: 120_000,
}

const RULE_ORDER = [
  // errors first — the things that stop a boot or a publish
  'pnpm-store-conflict',
  'patch-name-unresolvable',
  'link-broken',
  'tool-collision',
  'dead-patch',
  'config-clobber',
  // then warnings — things that rot
  'entry-removed',
  'duplicate-capability',
  'orphan-backup',
  'github-source',
  'plugin-stale',
  'plugin-not-mounted',
  'publish-scope',
  // then the informational diff
  'entry-toggled',
  'entry-added',
]

const SEVERITY_MARK = { error: '✗', warn: '!', info: '·' }

function renderText(findings, summary, profile) {
  const lines = []
  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of findings) counts[f.severity] += 1
  lines.push('')
  lines.push(`dsh-profile-doctor · profile ${profile} · ${summary.entries} entries (${summary.disabled} disabled)`)
  lines.push('')
  if (findings.length === 0) {
    lines.push('  · no problems found')
    lines.push('')
    return lines.join('\n')
  }
  const ordered = [...findings].sort((a, b) => {
    const sa = RULE_ORDER.indexOf(a.rule)
    const sb = RULE_ORDER.indexOf(b.rule)
    return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb)
  })
  for (const f of ordered) {
    lines.push(`${SEVERITY_MARK[f.severity] ?? '·'} ${f.title}  [${f.rule}]`)
    if (f.plugin) lines.push(`    ${f.plugin}`)
    lines.push(`    ${f.detail}`)
    if (f.rule === 'config-clobber') {
      for (const d of f.data.dropped ?? []) lines.push(`      - ${d.path}${d.value ? `: ${d.value}` : ''}`)
    }
    if (f.fix) {
      const fixLines = f.fix.split('\n')
      lines.push(`    fix ${fixLines[0]}`)
      for (const l of fixLines.slice(1)) lines.push(`        ${l}`)
    }
    lines.push('')
  }
  const parts = []
  if (counts.error) parts.push(`${counts.error} error`)
  if (counts.warn) parts.push(`${counts.warn} warning`)
  if (counts.info) parts.push(`${counts.info} note`)
  lines.push(parts.join(' · '))
  lines.push('')
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const cfg = { ...Config, ...config }

  /** The full pipeline: dumps, parse, every check. */
  async function runAudit(profile, opts = {}) {
    const profileDir = join(dshHome(), 'profiles', profile)
    const offline = opts.offline ?? cfg.offline
    let composed = []
    let defaults = []
    let dumpError = null
    try {
      const dumps = await captureDumps(profile, { timeoutMs: cfg.cliTimeoutMs, cwd: opts.cwd })
      composed = parseDump(dumps.composed)
      defaults = parseDump(dumps.default)
    } catch (error) {
      // A dump that will not render still leaves the filesystem checks useful.
      dumpError = String(error?.message || error).slice(0, 300)
    }
    const patchFiles = readUserPatches(profile)
    const manifest = readProfileManifest(profile)
    const findings = []
    if (dumpError === null) {
      findings.push(...checkClobber(composed, defaults))
      findings.push(...checkDeadPatches(composed, patchFiles))
      findings.push(...checkToolCollisions(profileDir, composed))
      findings.push(...checkToggles(composed, defaults))
      findings.push(...checkDuplicateCapabilities(composed, readDescriptions(profileDir)))
    }
    findings.push(...checkPatchNames(profileDir, patchFiles))
    findings.push(...checkBrokenLinks(profileDir))
    findings.push(...checkStoreConflict(profileDir))
    findings.push(...checkOrphanBackups(profileDir))
    findings.push(...checkGithubSources(manifest))
    findings.push(...checkPublishScope(profileDir))
    if (dumpError === null) findings.push(...(await checkPlugins(manifest, composed, { offline })))
    return {
      findings,
      summary: summarize(composed),
      profile,
      dumpError,
      releaseAge: readReleaseAgeExcludes(profileDir),
    }
  }

  const OUTPUT_SCHEMA = { type: 'json' }
  const render = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

  const tools = [
    {
      name: 'profile_doctor',
      description:
        'Audit this DSH profile end to end and report every problem that boots silently: config fields a patch dropped, patches targeting entry ids that no longer exist, tool-name collisions between mounted plugins, plugins installed but never mounted, plugins that stopped publishing, plus the ecosystem checks — pnpm store version conflicts that break `dsh plugin add`, patch insert names node_modules cannot resolve, broken junctions/symlinks, duplicate-capability plugins, orphan backup directories, GitHub-source dependencies, and npm publish-scope hints. Read-only; nothing is written. Returns a text report plus {findings, summary, counts}.',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Profile to audit. Defaults to config.profile (desktop).' },
          offline: { type: 'boolean', description: 'Skip the npm registry staleness check (no network).' },
        },
      },
      async execute(args) {
        const profile = args.profile || cfg.profile
        const result = await runAudit(profile, { offline: args.offline })
        const text = renderText(result.findings, result.summary, profile)
        return {
          ok: true,
          report: text,
          findings: result.findings,
          summary: result.summary,
          counts: {
            error: result.findings.filter((f) => f.severity === 'error').length,
            warn: result.findings.filter((f) => f.severity === 'warn').length,
            info: result.findings.filter((f) => f.severity === 'info').length,
          },
          dumpError: result.dumpError,
        }
      },
    },
    {
      name: 'profile_doctor_explain',
      description:
        'Explain what this harness is actually made of: entry counts by functional area (derived from package names, so it tracks upstream naming), which entries are off, which are conditional, and the full third-party plugin list. A healthy audit says "no problems found", which tells you nothing about what you are running — this answers that instead.',
      parameters: {
        type: 'object',
        properties: { profile: { type: 'string', description: 'Profile to explain. Defaults to config.profile.' } },
      },
      async execute(args) {
        const profile = args.profile || cfg.profile
        let composed = []
        let error = null
        try {
          const dumps = await captureDumps(profile, { timeoutMs: cfg.cliTimeoutMs })
          composed = parseDump(dumps.composed)
        } catch (e) {
          error = String(e?.message || e).slice(0, 300)
        }
        if (error) return { ok: false, error, hint: 'dsh --dump-config failed; run it manually to see why.' }
        return { ok: true, explain: renderExplain(composed), summary: summarize(composed) }
      },
    },
    {
      name: 'profile_doctor_release_age',
      description:
        'Report the pnpm-workspace release-age policy: which packages are exempted via minimumReleaseAgeExclude, which installed plugins are still inside the cooldown window (so `dsh plugin add` would resolve them to an older version or refuse), and the exact YAML lines to add. This is the failure mode that makes a freshly published plugin look missing.',
      parameters: {
        type: 'object',
        properties: { profile: { type: 'string', description: 'Profile whose workspace to inspect.' } },
      },
      async execute(args) {
        const profile = args.profile || cfg.profile
        const profileDir = join(dshHome(), 'profiles', profile)
        const policy = readReleaseAgeExcludes(profileDir)
        const manifest = readProfileManifest(profile)
        const deps = Object.keys(manifest?.json?.dependencies ?? {})
        // Best-effort: which deps are inside the cooldown right now.
        const blocked = []
        for (const name of deps) {
          try {
            const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
              headers: { accept: 'application/vnd.npm.install-v1+json' },
            })
            if (!res.ok) continue
            const json = await res.json()
            const created = json?.time?.created
            const latestVersion = json?.['dist-tags']?.latest
            const versionTime = latestVersion ? json?.time?.[latestVersion] : null
            if (!versionTime) continue
            const hours = (Date.now() - new Date(versionTime)) / 3_600_000
            if (hours < 24) {
              blocked.push({ name, version: latestVersion, publishedHoursAgo: Number(hours.toFixed(1)) })
            }
          } catch {}
        }
        const exempt = new Set(policy.entries.map((e) => e.split('@')[0]))
        const needed = blocked.filter((b) => !exempt.has(b.name) && !policy.entries.some((e) => e.startsWith(`${b.name}@`)))
        return {
          ok: true,
          file: policy.file,
          exempted: policy.entries,
          insideCooldown: blocked,
          missingExemptions: needed,
          fix:
            needed.length === 0
              ? null
              : `Add to minimumReleaseAgeExclude in ${policy.file}:\n` +
                needed.map((n) => `  - '${n.name}@${n.version}'`).join('\n') +
                '\n\nOr pass --config.minimum-release-age=0 to the pnpm call for one operation.',
        }
      },
    },
    {
      name: 'profile_doctor_links',
      description:
        'Inspect the profile node_modules for links: every junction/symlink, whether its target still resolves to a package, and which patch insert rows depend on a package that is not there. Use this after a `dsh plugin add` failed with ERR_PNPM_UNEXPECTED_STORE, or after moving a local plugin checkout. Read-only.',
      parameters: {
        type: 'object',
        properties: { profile: { type: 'string', description: 'Profile to inspect.' } },
      },
      async execute(args) {
        const profile = args.profile || cfg.profile
        const profileDir = join(dshHome(), 'profiles', profile)
        const patchFiles = readUserPatches(profile)
        return {
          ok: true,
          findings: [...checkPatchNames(profileDir, patchFiles), ...checkBrokenLinks(profileDir), ...checkStoreConflict(profileDir)],
          patchRows: patchFiles.map((f) => ({ file: f.path, ids: f.ids.length, inserts: f.inserts })),
        }
      },
    },
  ]

  for (const t of tools) {
    try {
      ctx.tools.register({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        output: { schema: OUTPUT_SCHEMA, render },
        timeoutMs: 180_000,
        isConcurrencySafe: () => false,
        presentCall: (args) => ({ card: 'generic', title: t.name, kind: 'tool', rawInput: args }),
        execute: t.execute,
      })
    } catch (error) {
      console.error(`[profile-doctor] ${t.name} registration skipped: ${error}`)
    }
  }
}
