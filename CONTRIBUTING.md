# Contributing to ThinkRail

Thanks for your interest in ThinkRail! Contributions of all kinds are welcome — bug
reports, fixes, features, docs, and feedback.

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE), and you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

Open a GitHub issue. Before filing, search existing issues to avoid duplicates. For
bug reports, include:

- What you did, what you expected, and what actually happened
- Your OS, Bun, and Node versions
- Relevant logs or a minimal reproduction

## Development setup

**Prerequisites:** [Bun](https://bun.sh) 1.4.4 (the repository's pinned package manager and runtime),
Node.js ≥ 22.19 (required by the in-process `pi` engine), and an authenticated `pi` provider for agent work.

```bash
git clone https://github.com/52zyd/ThinkRail.git
cd ThinkRail
bun install --frozen-lockfile
bun run dev
```

`bun run dev` boots the host and the web client together and cleans up on `Ctrl+C`. Source/dev runs and
locally unstamped builds expose no application updater: update a checkout with Git and rebuild it.
Running `thinkrail update` from source installs a published binary; it does not pull, install
dependencies, or rebuild the checkout. On-disk app state (projects, workspaces, worktrees) lives under
`~/.thinkrail`.

To run the launchers:

```bash
bun run --filter @thinkrail/cli dev  # browser launcher
bun run build:binary                 # standalone CLI artifact
bun run desktop:dev                  # package and open the Electrobun app
bun run desktop:build                # package without opening it
```

Desktop commands use the standard Electrobun CLI/configuration. Its pre-build hook builds the shared UI
and stages ThinkRail's PI/native resources; Electrobun owns preload bundling and installer creation.
Create host-native installers with `bun run desktop:package:stable` or `bun run desktop:package:canary`;
`canary` is Electrobun's internal name for the public **nightly** channel. Native/installer smoke and shared
CLI/desktop probes live in `packages/artifact-tests`, outside the application packages. Run
`bun run smoke:desktop` after a dev build; installer smoke takes an artifact path and channel via
`bun run smoke:desktop:installer <path> <stable|canary>`. Local installer smoke is not notarization
verification: the coordinated macOS release pipeline signs Electrobun's expanded app archive and finalizes
the DMG, and that intermediate archive is not a public download.

Windows installer smoke must run on a disposable GitHub-hosted runner. The installer writes real
shortcuts and HKCU uninstall entries outside an isolated HOME; do not run it on your workstation or
override the harness's environment guard. Expanded-application smoke can run locally with the
harness's disposable home, data, agent and cache directories.

The Windows package distributed with this fork lives in `bytools/`. Keep the setup executable and its
adjacent `.installer` payload together; see [`bytools/README.txt`](bytools/README.txt) for the local build's
signature, update-feed and verification limitations. Rebuilds appear in `apps/desktop/artifacts/`, not
automatically in `bytools/`.
The generated `.installer` payload is excluded from source formatting so its delivered bytes and
checksums remain intact; do not hand-edit its metadata or compressed application archive.

## Repository layout

[`architecture.md`](architecture.md) lists every app and package with its role and allowed dependencies;
each module carries its own `SPEC.md`.

## Testing and linting

Keep maintained unit tests, browser specs and fixtures in the repository. Do not commit local debug
scripts, credentials, dependency caches, traces, reports or temporary screenshots. The root `.gitignore`
already excludes `node_modules/`, `test-results*/`, `playwright-report*/`, `e2e/screenshots/` and desktop
staging/build outputs. Deliberate README screenshots belong in `.github/readme-assets/`.

Run the fast gates before opening a PR (they also run as the husky pre-commit hook):

```bash
bun run lint        # biome
bun run typecheck   # tsc across all packages
bun run test        # unit tests (root tooling + each package)
```

Every change that touches the app is verified by the end-to-end suite against the
real UI. The no-agent gate builds once and automatically uses isolated parallel
shards (half the available CPUs, capped at eight):

```bash
bunx playwright install chromium                    # one-time
bun run e2e                                         # complete no-agent gate
bun run e2e -- e2e/changes.spec.ts                  # focused iteration
bun run e2e -- --last-failed                        # repair loop
bun run e2e:serial                                  # one-host debugging fallback
bun run e2e -- --shards=12                          # explicit 1–16 override
bun run e2e:binary                                  # packaged CLI host (build first)
bun run e2e:desktop                                 # packaged desktop host (build first)
bun run e2e:full                                    # everything; needs pi auth
bun run e2e:agent                                   # only @agent; remains serial
```

Use focused or last-failed runs while iterating, then run the complete `bun run e2e`
once before handoff. On macOS, every public browser E2E command prevents idle system sleep for the
runner's lifetime while allowing the display to sleep normally. Agent-driven specs are tagged `@agent`
and run against a real provider on an **isolated** `pi` agent dir — never your real `~/.pi/agent`.

## Module boundaries

ThinkRail is built as a set of clearly bounded, fractal modules: each package is a
module, and directories inside a package are modules too. A sub-module exposes its
public surface through an `index.ts` barrel; siblings import through that barrel,
never its internals. Every module has a `SPEC.md` that states what it owns, what it
exposes, and what it must not reach into. Keep changes within these boundaries, and
cover a module's public surface with tests where practical.

## Specification-driven development

ThinkRail is developed spec-first: hierarchical, interconnected specs live in the
repo alongside the code — top-level specs at the root
([`goal-and-requirements.md`](goal-and-requirements.md),
[`architecture.md`](architecture.md)) and a co-located `SPEC.md` for every module.
**The spec leads the code:** a change that moves or blurs a boundary, contract, or
decision updates the relevant `SPEC.md` first, then the code and the tests that pin
it. See [`AGENTS.md`](AGENTS.md) for the spec workflow.

## Translations

This fork defaults new or missing language preferences to `zh-CN`; explicit saved preferences are kept.
Tests that assert English UI copy must select English explicitly rather than depend on the machine's locale.

ThinkRail's interface strings live in one file,
[`packages/locales/en.json`](packages/locales/en.json): a flat JSON object of named keys
(`"settings.language.title": "Language"`). A translation is the same file with the values translated.

1. Copy `en.json` into `~/.thinkrail/locales/` as your language's code — `de.json`, `pt-BR.json`,
   `zh-Hant.json`. Keep the keys; translate the values. Strings you leave out stay in English.
2. Keep every `{{placeholder}}` exactly as written (a string whose placeholders differ from English is
   ignored) and keep `<0>…</0>` markers around the same words.
3. Counters come in plural forms: English has `key_one` and `key_other`; write the forms your language
   uses from `_zero`, `_one`, `_two`, `_few`, `_many`, `_other`
   ([CLDR plural rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html)).
   Russian, for example, uses `_one` (1, 21, 31…), `_few` (2–4, 22–24…), `_many` (5–20…) and `_other`:
   `"tools.read.firstLines_one": "первая {{count}} строка"`,
   `"tools.read.firstLines_few": "первые {{count}} строки"`,
   `"tools.read.firstLines_many": "первые {{count}} строк"`. Each form may show `{{count}}` or leave it
   out; a form you skip falls back to your `_other`, so a counter never switches to English.
4. Open **Settings → Language** and pick your language. ThinkRail reloads the file every time you save,
   and the page shows a problem with the file if it can't be read.

To ship a translation built-in for everyone, open a pull request that adds it as
`packages/locales/<code>.json` and registers it in `BUNDLED` in `packages/locales/src/index.ts`. It may
be partial; `bun run test` checks it against `en.json` (keys, placeholders, markup, plural forms). Agent
replies, tool output, skills, and prompts are not part of the interface and are not translated.

## Submitting changes

### Windows Community Release

Use this repository's **Actions → Release Windows → Run workflow** from `main`, with a new stable
`X.Y.Z` version (the first is `0.1.0`). The workflow installs the lockfile, runs all fast, unit and no-agent
browser gates, then verifies the CLI, expanded desktop and installer on a disposable hosted Windows runner.
Failed gates prevent publication. Never run Windows installer smoke on a personal workstation: it writes
real Windows shortcuts and uninstall registration outside an isolated home directory.

The immutable version release contains the standalone CLI, desktop ZIP and checksums. The separate
`desktop-updates` release is never latest; its official archive uploads before its manifest. Updates and
installation scripts use `52zyd/ThinkRail`, with no upstream fallback. These builds are unsigned; neither
checksums nor a successful build certify a publisher. Old desktop installations require one manual
reinstall of the new full ZIP to migrate the baked-in update feed.

When refreshing `bytools/`, replace the setup EXE, both adjacent `.installer` files and the full ZIP together,
then regenerate `SHA256SUMS` from final bytes, including the accompanying `README.txt`. Retain maintained
test sources and fixtures; do not commit local test runs, debug scripts, caches, logs, credentials or reports.

1. [Fork the repository](https://docs.github.com/articles/fork-a-repo) and create a
   branch off `main`.
2. Make your change, keeping it focused. Match the surrounding code style and the
   conventions in `AGENTS.md`.
3. Add or update tests and specs, and run the checks above.
4. Open a [pull request](https://docs.github.com/articles/creating-a-pull-request)
   against `main` with a clear description of *what* changed and *why*.

Write commit messages and PR descriptions that explain the reasoning behind the
change, not just the mechanics. A maintainer will review your PR and may suggest
adjustments before merging.
