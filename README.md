# dsh-profile-doctor — 插件生态自诊（DSH 插件）

> 你的 DSH 配置里有设置项在**静默失效**，你的 node_modules 里有链接在**悄悄断裂**，你的 `.dsh` 目录里躺着没人引用的备份。这个插件把那些事一件件找出来，并告诉你怎么修。

两类检查合一：**配置树七检**（config-clobber / dead-patch / tool-collision / plugin-not-mounted / plugin-stale / entry diff / explain）+ **生态八检**（pnpm store 冲突 / patch 名不可解析 / 链接断裂 / 重复能力 / 孤儿备份 / GitHub 源 / 发布权限 / release-age 豁免）。

## 安装

```sh
dsh plugin --profile desktop add @bushizhanghan/dsh-profile-doctor
```

重启 DSH 后生效。**只读**：这个插件从不写你的 profile。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `profile_doctor` | 全量体检，返回文本报告 + 结构化 findings（含每条 fix） |
| `profile_doctor_explain` | 解释这个 harness 到底由什么组成：按功能区分的条目数、哪些关着、哪些条件启用、第三方插件全列表 |
| `profile_doctor_release_age` | pnpm 发布冷静期体检：谁被豁免了、谁还在冷却窗口内、该往 `minimumReleaseAgeExclude` 加什么行 |
| `profile_doctor_links` | node_modules 链接专项：每个 junction/symlink 的目标是否还在、哪些 patch insert 行指向不存在的包、pnpm store 版本是否冲突 |

## 检查清单

### 配置树（与 dsh-doctor 同源的七检）

| 规则 | 级别 | 抓什么 |
|---|---|---|
| `config-clobber` | ✗ error | patch 覆盖 config 时**整体替换**，没重述的兄弟字段静默消失 |
| `dead-patch` | ✗ error | patch 指向的 entry id 不存在（带编辑距离 did-you-mean） |
| `tool-collision` | ✗ error | 两个挂载插件注册同名工具——DSH 直接拒绝启动 |
| `entry-removed` | ! warn | 出厂 profile 里的条目被你的 patch 删了 |
| `plugin-not-mounted` | ! warn | 装了但既不在 bundles 也没被 patch insert，从不加载 |
| `plugin-stale` | ! warn | 180 天没发新版（DSH 在 preview 期，breaking change 频繁） |
| `entry-toggled` / `entry-added` | · info | 树 diff 可见化 |

### 生态（本插件的增量，全部来自真实踩坑）

| 规则 | 级别 | 抓什么 |
|---|---|---|
| `pnpm-store-conflict` | ✗ error | node_modules 是 v10 store 链的，而 CLI 的 pnpm 是 v11 → `dsh plugin add` 报 `ERR_PNPM_UNEXPECTED_STORE` |
| `patch-name-unresolvable` | ✗ error | patch insert 的 `name` 在 node_modules 里找不到（scoped 包放错层级：必须在 `@scope/` 下） |
| `link-broken` | ✗ error | junction/symlink 目标已消失（含 lstat 就失败的坏 junction） |
| `duplicate-capability` | ! warn | 两个第三方插件提供同一能力（如两个 code-review） |
| `orphan-backup` | ! warn | `backup-*` 目录没有任何东西引用，只占地方 |
| `github-source` | ! warn | `github:` 依赖：需要联网、绕过 registry 完整性校验、force-push 会变 |
| `publish-scope` | · info | granular token 发不了裸包名（E403）——提示走 scoped 名 |
| release-age | 工具 | 谁在 pnpm 冷却窗口内、`minimumReleaseAgeExclude` 缺哪行 |

## 它抓到的真实问题（这台机器上）

```
! "backup-workmate-lib-20261023-1252" is a backup directory nothing references (329 KB, 6 files)
! "backup-workmate-lib-20261023-1245" is a backup directory nothing references (324 KB, 6 files)
! "backup-workmate-lib-20261023-1242" is a backup directory nothing references (322 KB, 6 files)
! "backup-plugin-upgrade-20261022" is a backup directory nothing references (96 KB, 7 files)
! "dsh-md-export" installs from github: instead of the npm registry
! "dsh-workbuddy" installs from github: instead of the npm registry
```

以及 `profile_doctor_release_age` 报出的 4 条豁免与冷却缺口。

## 设计取舍

- **dump 解析用缩进不用 YAML 库**：dump 里嵌 `!!js` 表达式，严格加载器会拒绝、宽松的会求值。我们只要「有哪些键」，直接读结构更安全也更零依赖。
- **网络检查尽力而为**：registry 超时把 staleness 降级成 unknown，而不是让体检失败——一个在防火墙后面跑不起来的医生，比一个报得少的医生更糟。
- **修不修由你定**：每条 finding 都带 `fix` 文案，但插件只读。改配置是人来决定的事（dsh-doctor 的 `--fix` 也刻意只留在 CLI，同理）。
- **重复能力是 warn 不是 error**：关键词重叠是启发式，你可能就是故意两个都用。

## 开发

```sh
node --test test/    # 16 个单测：dump 解析、七检、生态八检
```

## License

MIT
