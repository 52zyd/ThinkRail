import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const actionPath = resolve(import.meta.dir, "../../../.github/actions/build-binary/action.yml");
const action = Bun.YAML.parse(readFileSync(actionPath, "utf8")) as {
	outputs: Record<string, { value: string }>;
	runs: { steps: { id?: string; name?: string; run?: string; env?: Record<string, string> }[] };
};
const roots: string[] = [];
const bash =
	process.platform === "win32"
		? resolve(Bun.which("git") ?? "git", "..", "..", "bin", "bash.exe")
		: "bash";
function shellPath(path: string): string {
	const slash = path.replace(/\\/g, "/");
	return slash.replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`);
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const targets = [
	{
		target: "bun-darwin-arm64",
		stable: "macos-arm64-ThinkRail.dmg",
		nightly: "canary-macos-arm64-ThinkRail-canary.dmg",
		published: "thinkrail-desktop-darwin-arm64.dmg",
		updates: {
			stable: {
				manifest: "stable-macos-arm64-update.json",
				archive: "stable-macos-arm64-ThinkRail.app.tar.zst",
			},
			nightly: {
				manifest: "canary-macos-arm64-update.json",
				archive: "canary-macos-arm64-ThinkRail-canary.app.tar.zst",
			},
		},
	},
	{
		target: "bun-windows-x64",
		stable: "win-x64-ThinkRail-Setup.zip",
		nightly: "canary-win-x64-ThinkRail-Setup-canary.zip",
		published: "thinkrail-desktop-windows-x64.zip",
		updates: {
			stable: {
				manifest: "stable-win-x64-update.json",
				archive: "stable-win-x64-ThinkRail.tar.zst",
			},
			nightly: {
				manifest: "canary-win-x64-update.json",
				archive: "canary-win-x64-ThinkRail-canary.tar.zst",
			},
		},
	},
	{
		target: "bun-linux-x64",
		stable: "linux-x64-ThinkRail-Setup.tar.gz",
		nightly: "canary-linux-x64-ThinkRail-canary-Setup.tar.gz",
		published: "thinkrail-desktop-linux-x64.tar.gz",
		updates: {
			stable: {
				manifest: "stable-linux-x64-update.json",
				archive: "stable-linux-x64-ThinkRail.tar.zst",
			},
			nightly: {
				manifest: "canary-linux-x64-update.json",
				archive: "canary-linux-x64-ThinkRail-canary.tar.zst",
			},
		},
	},
	{
		target: "bun-linux-arm64",
		stable: "linux-arm64-ThinkRail-Setup.tar.gz",
		nightly: "canary-linux-arm64-ThinkRail-canary-Setup.tar.gz",
		published: "thinkrail-desktop-linux-arm64.tar.gz",
		updates: {
			stable: {
				manifest: "stable-linux-arm64-update.json",
				archive: "stable-linux-arm64-ThinkRail.tar.zst",
			},
			nightly: {
				manifest: "canary-linux-arm64-update.json",
				archive: "canary-linux-arm64-ThinkRail-canary.tar.zst",
			},
		},
	},
] as const;

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-release-collector-"));
	roots.push(root);
	const artifacts = join(root, "apps/desktop/artifacts");
	mkdirSync(artifacts, { recursive: true });
	for (const target of targets) {
		writeFileSync(join(artifacts, target.nightly), `nightly:${target.target}`);
		writeFileSync(join(artifacts, target.stable), `stable:${target.target}`);
		for (const channel of ["stable", "nightly"] as const) {
			const update = target.updates[channel];
			writeFileSync(join(artifacts, update.manifest), `${channel}:${target.target}:manifest`);
			writeFileSync(join(artifacts, update.archive), `${channel}:${target.target}:archive`);
		}
	}
	writeFileSync(join(artifacts, "macos-arm64-ThinkRail.app.tar.zst"), "wrong stable prefix");
	writeFileSync(join(artifacts, "stable-win-x64-update-old.json"), "stale manifest");
	writeFileSync(join(artifacts, "old-setup.zip"), "unrelated");
	return root;
}

function packageDesktop(root: string, target: string, channel: string) {
	const script = action.runs.steps.find((step) => step.name === "Package desktop installer")?.run;
	if (!script) throw new Error("desktop package script is missing");
	return Bun.spawnSync(
		[bash, "-c", `export PATH=${JSON.stringify(shellPath(join(root, "bin")))}:$PATH\n${script}`],
		{
			cwd: root,
			env: {
				...process.env,

				SYSTEMROOT: "C:\\Windows",
				TARGET: target,
				CHANNEL: channel,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

function collect(root: string, target: string, channel: string) {
	const collector = action.runs.steps.find((step) => step.id === "resolve-desktop")?.run;
	if (!collector) throw new Error("desktop artifact collector is missing");
	return Bun.spawnSync([bash, "-c", collector], {
		cwd: root,
		env: {
			...process.env,
			TARGET: target,
			CHANNEL: channel,
			GITHUB_OUTPUT: shellPath(join(root, "outputs")),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

function stampIdentity(channel: string, key: string, extra: Record<string, string> = {}) {
	const script = action.runs.steps.find(
		(step) => step.name === "Stamp shared release identity",
	)?.run;
	if (!script) throw new Error("release identity stamp script is missing");
	const root = mkdtempSync(join(tmpdir(), "thinkrail-release-stamp-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(root, "packages/shared/src"), { recursive: true });
	writeFileSync(join(bin, "git"), "#!/bin/sh\necho abc1234\n", { mode: 0o755 });
	const result = Bun.spawnSync(
		[bash, "-c", `export PATH=${JSON.stringify(shellPath(join(root, "bin")))}:$PATH\n${script}`],
		{
			cwd: root,
			env: {
				...process.env,

				VERSION: "1.2.3",
				CHANNEL: channel,
				POSTHOG_PROJECT_KEY: key,
				...extra,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const versionPath = join(root, "packages/shared/src/version.ts");
	return {
		result,
		stamped: existsSync(versionPath) ? readFileSync(versionPath, "utf8") : undefined,
	};
}

test("release stamping is key-free even with legacy telemetry credentials", () => {
	const { result, stamped } = stampIdentity("stable", "phc_release");
	expect(result.exitCode).toBe(0);
	expect(stamped).toBe(
		[
			'export const version = "1.2.3";',
			'export const channel = "stable";',
			'export const commit = "abc1234";',
			"",
		].join("\n"),
	);
	expect(stamped).not.toContain("posthog");
	expect(`${result.stdout}${result.stderr}`).not.toContain("phc_release");
});

test("release stamping rejects development channel", () => {
	const { result, stamped } = stampIdentity("dev", "");
	expect(result.exitCode).not.toBe(0);
	expect(stamped).toBeUndefined();
});

test("the build recipe accepts no telemetry or upload credentials", () => {
	expect(readFileSync(actionPath, "utf8").toLowerCase()).not.toContain("posthog");
});

test("Windows publication waits for every gate and publishes the official feed archive first", () => {
	const workflow = readFileSync(
		resolve(import.meta.dir, "../../../.github/workflows/release-windows.yml"),
		"utf8",
	);
	for (const gate of [
		"check:deps",
		"check:boundaries",
		"check:seams",
		"check:spec-surface",
		"check:i18n",
		"check:compiler",
		"lint",
		"typecheck",
		"test",
		"e2e",
	]) {
		expect(workflow).toContain(`bun run ${gate}`);
	}
	expect(workflow).toContain("needs: build");
	expect(workflow).toContain('default: "0.1.0"');
	expect(workflow).toContain("--latest=false");
	expect(workflow).toContain("refs/heads/main");
	expect(workflow).toContain("52zyd/ThinkRail");
	expect(workflow).not.toContain("e2e:full");
	expect(
		workflow.indexOf("gh release upload desktop-updates stable-win-x64-ThinkRail.tar.zst"),
	).toBeLessThan(workflow.indexOf("gh release upload desktop-updates stable-win-x64-update.json"));
});

test("Windows packaging places System32 tar ahead of Git tar", () => {
	const root = fixture();
	const bin = join(root, "bin");
	const system32 = join(root, "windows", "System32");
	mkdirSync(bin, { recursive: true });
	mkdirSync(system32, { recursive: true });
	writeFileSync(
		join(bin, "cygpath"),
		`#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(shellPath(join(root, "windows")))}\n`,
		{ mode: 0o755 },
	);
	writeFileSync(join(system32, "tar"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	writeFileSync(
		join(bin, "bun"),
		`#!/bin/sh\nprintf '%s\\n%s\\n' "$PATH" "$*" > ${JSON.stringify(shellPath(join(root, "package-call")))}\n`,
		{ mode: 0o755 },
	);
	const result = packageDesktop(root, "bun-windows-x64", "nightly");
	expect(result.exitCode).toBe(0);
	const [path, args] = readFileSync(join(root, "package-call"), "utf8").split("\n");
	expect(path?.split(":")[0]).toBe(shellPath(system32));
	expect(args).toBe("run --cwd apps/desktop package:canary");
});

test("non-Windows packaging does not require cygpath or rewrite PATH", () => {
	const root = fixture();
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "bun"),
		`#!/bin/sh\nprintf '%s\\n%s\\n' "$PATH" "$*" > ${JSON.stringify(shellPath(join(root, "package-call")))}\n`,
		{ mode: 0o755 },
	);
	expect(packageDesktop(root, "bun-linux-x64", "stable").exitCode).toBe(0);
	const [path, args] = readFileSync(join(root, "package-call"), "utf8").split("\n");
	expect(path?.split(":")[0]).toBe(shellPath(bin));
	expect(args).toBe("run --cwd apps/desktop package:stable");
});

test("preserves existing public outputs and adds both update artifact paths", () => {
	expect(
		Object.fromEntries(Object.entries(action.outputs).map(([key, { value }]) => [key, value])),
	).toEqual({
		"artifact-name": `\${{ steps.resolve-cli.outputs.name }}`,
		"artifact-path": `\${{ steps.resolve-cli.outputs.path }}`,
		"desktop-artifact-name": `\${{ steps.resolve-desktop.outputs.name }}`,
		"desktop-artifact-path": `\${{ steps.resolve-desktop.outputs.path }}`,
		"desktop-app-archive-path": `\${{ steps.resolve-desktop.outputs.app-archive-path }}`,
		"desktop-update-manifest-path": `\${{ steps.resolve-desktop.outputs.update-manifest-path }}`,
		"desktop-update-archive-path": `\${{ steps.resolve-desktop.outputs.update-archive-path }}`,
	});
});

for (const target of targets) {
	for (const channel of ["stable", "nightly"] as const) {
		test(`collects the exact ${channel} ${target.target} installer and updater outputs among stale and sibling artifacts`, () => {
			const root = fixture();
			const result = collect(root, target.target, channel);
			expect(result.exitCode).toBe(0);
			expect(readFileSync(join(root, "apps/desktop/dist", target.published), "utf8")).toBe(
				`${channel}:${target.target}`,
			);
			const update = target.updates[channel];
			const updateManifestPath = `apps/desktop/artifacts/${update.manifest}`;
			const updateArchivePath = `apps/desktop/artifacts/${update.archive}`;
			const appArchivePath = target.target === "bun-darwin-arm64" ? updateArchivePath : "";
			expect(readFileSync(join(root, "outputs"), "utf8")).toBe(
				`name=${target.published}\npath=apps/desktop/dist/${target.published}\napp-archive-path=${appArchivePath}\nupdate-manifest-path=${updateManifestPath}\nupdate-archive-path=${updateArchivePath}\n`,
			);
			expect(readdirSync(join(root, "apps/desktop/dist"))).toEqual([target.published]);
			expect(readFileSync(join(root, updateManifestPath), "utf8")).toBe(
				`${channel}:${target.target}:manifest`,
			);
			expect(readFileSync(join(root, updateArchivePath), "utf8")).toBe(
				`${channel}:${target.target}:archive`,
			);
		});
	}
}

test("refuses a missing requested installer instead of collecting a stale channel", () => {
	const root = fixture();
	rmSync(join(root, "apps/desktop/artifacts/macos-arm64-ThinkRail.dmg"));
	expect(collect(root, "bun-darwin-arm64", "stable").exitCode).not.toBe(0);
});

test.each([
	"stable",
	"nightly",
] as const)("refuses a missing requested %s macOS app archive instead of falling back to another artifact", (channel) => {
	const root = fixture();
	const appArchivePath = `apps/desktop/artifacts/${targets[0].updates[channel].archive}`;
	rmSync(join(root, appArchivePath));
	const result = collect(root, targets[0].target, channel);
	expect(result.exitCode).not.toBe(0);
	expect(result.stdout.toString()).toContain(
		`::error::desktop app archive not found at ${appArchivePath}`,
	);
	expect(existsSync(join(root, "outputs"))).toBe(false);
});

test.each([
	["manifest", "manifest"],
	["archive", "archive"],
] as const)("refuses a missing requested update %s instead of falling back to another artifact", (kind, field) => {
	const root = fixture();
	const expected = targets[1].updates.nightly[field];
	const expectedPath = `apps/desktop/artifacts/${expected}`;
	rmSync(join(root, expectedPath));
	const result = collect(root, targets[1].target, "nightly");
	expect(result.exitCode).not.toBe(0);
	expect(result.stdout.toString()).toContain(
		`::error::desktop update ${kind} not found at ${expectedPath}`,
	);
	expect(existsSync(join(root, "outputs"))).toBe(false);
});

test.each([
	["bun-darwin-x64", "stable"],
	["bun-darwin-arm64", "production"],
])("refuses an unsupported target/channel: %s %s", (target, channel) => {
	expect(collect(fixture(), target, channel).exitCode).not.toBe(0);
});
