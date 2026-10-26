---
id: module-ci-release
type: module-design
status: active
title: CI & release pipeline
parent: architecture
depends-on: [module-cli, module-desktop, module-shared, module-repo-scripts, module-artifact-tests]
---

## Responsibility

Public PR gates, contribution templates, reusable native build recipes and the manual Windows release
workflow. This module owns source authorization, checksums, publication and the action's artifact/version
contract. No signing/notary credentials or service are configured.

## Boundary

- **Owns:** public CI/site workflows, contribution templates, native build recipes, version calculation,
  and the artifact
  interface consumed by the manual Windows workflow.
- **Consumes:** CLI and desktop build commands, [[module-artifact-tests]] smoke entrypoints, shared
  version stamping, root conformance/unit/browser commands, git, and native platform tools.
- **Forbidden:** product runtime logic; alternate artifact runtimes; signing credentials in source;
  publication before required verification; checksums over intermediate bytes; or a
  release-only application build path that bypasses normal package commands.

## CI

Workflow Bun setup reads the root `package.json` `packageManager` pin through `bun-version-file`.
Desktop's packaged runtime remains Electrobun-owned (see [[module-desktop]]).

PR and merge-queue gates cover dependency/boundary/seam/spec-surface conformance, lint/typecheck, unit and
no-agent browser tests. Linux and Windows run native CLI artifact smoke; Linux also runs browser tests
against the compiled binary. Desktop coverage builds the Linux target, runs native-window and shared
artifact probes under Xvfb with test-only software-rendering flags, and runs desktop-backed browser tests.
The Linux binary and desktop suites run on every merge group but on a PR only when its change can affect
artifacts (change classifier below). Real-provider tests remain explicitly authorized and separate.

The three browser suites dominate wall time, so each runs as a matrix of Playwright shards on separate
runners ([[module-browser-e2e]] owns the slicing). Shard counts trade runner minutes for wall time and are
tuned against observed per-job durations.

**Required gate.** The ruleset requires one check, "CI passed": an aggregate job that succeeds only when the
change classifier, conformance/lint/typecheck and unit tests succeeded and every other job either succeeded
or was skipped by the classifier. CI can then add, rename or skip jobs without a ruleset edit; renaming "CI
passed" itself blocks the merge queue. Every job carries a timeout a few times its healthy duration, so a
hung process fails its job, and with it "CI passed", within minutes instead of holding a runner for GitHub's
six-hour default.

**Change classifier.** A `changes` job diffs the PR or merge group against its base, counting a rename as
both its old and new path. When every changed path lies outside the app — the website and its analytics
package, the website workflows, README screenshots — the classifier skips the pi-package, browser, binary,
Windows and desktop jobs; any other path, or a failed diff, runs them all. The exclusion list is a path
allow-list, never a file-type rule: Markdown is product input here (skills ship in the artifacts, specs feed
conformance gates). In the merge queue it diffs against the target branch, not the event's `base_sha`: that
is the previous entry's group head, and with HEADGREEN grouping a green head merges every entry ahead, so a
site PR queued behind an app PR must still run the full set. Conformance, lint/typecheck and unit tests
always run; they are cheap and cover the website too. A second output, `artifacts`, gates the Linux binary
and desktop suites, which replay the no-agent browser suite against built artifacts and cost over half of
CI's runner time: on a PR they run only when a path feeds building or packaging — the CLI and desktop apps,
artifact tests, the server's build support and bundled-runtime registration, the artifact Playwright
runners, CI definitions, patches and the root manifests and lockfile — and in a merge group they always run,
so main never lands an artifact they have not exercised. An artifact-only defect in an unrelated change
therefore surfaces at enqueue time instead of on the PR; it was 1 in 56 failed runs before the split. That
includes the shared no-agent specs and fixtures the artifact suites replay: only the artifact runners and
configs are classifier paths, so a harness change that breaks only the binary or desktop replay is also
caught at enqueue. The Windows job stays on every app PR: it is mostly native unit gates, not an artifact
replay.

Browser jobs retry the Playwright browser download a bounded number of times, a network fault that otherwise
ejects an entry from the merge queue; inside a job Playwright retries a failed test once on CI (source and
artifact configs alike), a test that passes on that retry is reported flaky and does not fail the job, and
no job is re-run automatically. They install Chromium without `--with-deps`: the runner image already
carries its shared libraries, and the extra apt packages (CJK/Thai/X fonts) feed no assertion while their
Ubuntu-mirror download was the slowest step of the job, often for minutes. A missing library fails
Chromium's launch loudly. The browsers themselves are not cached: the Playwright CDN download takes seconds,
no slower than an Actions-cache restore of the same bytes.

Native artifact smokes run only in shard 1: repeating an identical probe per shard adds no coverage and
multiplies exposure to runner-environment faults.

Linux desktop jobs install their GTK/WebKitGTK runtime through `.github/actions/desktop-apt`, from `.deb`
files cached under a hash of the exact package versions apt plans to install after `apt-get update`. A
mirror update or a different runner image changes that plan and so the key: the previous cache is restored
by prefix, only the changed packages download, and `apt-get autoclean` drops versions the archive no longer
offers, so a slow Ubuntu mirror costs little between image releases and while an image rolls out. A cache
saved on a PR or merge-group ref is private to that ref, so the `CI cache` workflow seeds it on every push
to main, the one scope every PR and merge group can restore. The install step is bounded at ten minutes: a
mirror that trickles bytes never trips apt's own timeouts and would otherwise hold the job for hours. The
jobs start Xvfb as their own step and proceed only once an X client connects to the exported `DISPLAY`; a
server that never answers is restarted a bounded number of times, then fails the job. Beyond the suites'
single Playwright retry, only the virtual display is retried: once it is proven, the smoke and browser tests
get no further environment retries.

A platform's native behavior is proven only on that platform. Windows remains a PR gate because its
executable, environment, path, and trash behavior differs materially from POSIX hosts. Its subprocess unit
gate also exercises native descendant-console behavior, which the Linux unit run cannot prove, and its
desktop window-chrome unit gate binds the `user32.dll` frame symbols the frameless title bar relies on
([[module-desktop]]); neither needs the Electrobun devkit. Its path gate (`bun run test:windows-paths`) runs
the suites that pin architecture Decision 22 on the one host where git prints `C:/…`, node prints `C:\…`,
and `\` is not a file-name character: stored directories, chat lifecycle in Default and external workspaces,
POSIX wire paths, git object names, picker roots, and `install.ps1`'s PATH check. A suite joins the gate only
once it passes on Windows. A test whose premise NTFS cannot hold, such as a `:` in a ref name or an
unprivileged symlink, is skipped there and stays covered on Linux. The gate runs with a 30 s per-test budget
instead of Bun's 5 s default: each git spawn costs ~40 ms there (the workspace suite runs about 14× slower
than on Linux, one passing test reached 4.2 s), and a runner stall such as on-access scanning of a fresh
install turns that into timeouts. Tests with an explicit timeout keep it. The runner's `TEMP` is an 8.3 short
name (`C:\Users\RUNNER~1\…`) while git reports the long one, so path fixtures are rooted at
`realpathSync.native`, the spelling git and the OS agree on. The installer file contributes only its
`install.ps1` suite, because its `install.sh` tests rightly reject the `~` such a prefix carries. Native
macOS and Linux ARM64 acceptance belongs to the release matrix. The Windows job installs Bun and its
dependencies without the Actions cache: restoring it took longer than a fresh install, and with no Windows
job on main every PR and merge group kept its own copy, about half of the repository's cache quota.

## Windows release contract

`release-windows.yml` is manual (`workflow_dispatch`), stable, Windows x64 only, default version `0.1.0`.
It rejects malformed or previously published version tags. It installs the locked dependencies and runs
all fast gates, unit tests and the complete no-agent browser suite before invoking `build-binary`.
The native recipe stamps `{ version, channel, commit }`, smokes the CLI, expanded desktop and first-install
artifact on the disposable Windows runner, and collects exact framework-generated names. No telemetry
key or source-map upload credential is accepted. Installer smoke must never run on a user's workstation.

After every gate passes, an immutable `vX.Y.Z` release contains the CLI, full desktop ZIP and SHA-256
checksums. The separate non-latest `desktop-updates` release contains the official stable
`stable-win-x64-ThinkRail.tar.zst` archive and `stable-win-x64-update.json` manifest. Upload the archive
first and the manifest last; never set this rolling feed as latest, rename payloads or point to upstream.
The initial version is `0.1.0`; development defaults remain `0.0.0-dev`. No signing service is configured:
these community artifacts are unsigned, and checksum verification is not publisher authentication.
Failed gates stop publication; the workflow does not spend real-provider tokens.

## CLI installation and other automation

Root `install.sh` and `install.ps1` remain CLI-only consumers: validate channel/version identity, resolve the
requested release, validate its tag against the selected channel's exact grammar before constructing any
artifact URL, download the native CLI plus `SHA256SUMS`, verify it, and stage replacement in the
destination directory before an atomic rename. Prefix checks are representation-based rather than ASCII-only:
Unicode and benign `@`/`+` components remain valid, while each platform rejects characters that would corrupt
metadata or startup-shell syntax. Git Bash writes native-readable Windows metadata; malformed shell PATH blocks
are preserved rather than rewritten. CLI self-update binds metadata to the running executable and invokes these
installers rather than duplicating download/checksum logic. Controlled script tests own these
regressions; finalized Windows PowerShell/Git-Bash and custom-volume behavior remains release qualification.
The `install.ps1` suite starts PowerShell once in a warm-up hook with its own budget before its timed tests:
the first `powershell.exe` launch on a fresh hosted runner has taken up to 31 s (2–14 s in passing runs),
a one-time environment cost that no single test's budget should absorb.

Website deployment contains no signing credentials. CODEOWNERS and the main-branch rules protect the
public recipes; local builds and public PR jobs never publish user-facing release artifacts.
