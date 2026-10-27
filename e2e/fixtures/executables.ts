import { spawnSync } from "node:child_process";
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_ENV_MARKER } from "@thinkrail/shared/shellEnv";

export function resolveBunExecutable(env: NodeJS.ProcessEnv = process.env): string {
	const name = process.platform === "win32" ? "bun.exe" : "bun";
	const executable = (env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((directory) => join(directory, name))
		.find(existsSync);
	if (!executable) throw new Error("bun executable not found for the e2e host");
	return executable;
}

export function hermeticE2ePath(fakeBinDir: string): string {
	if (process.platform === "win32") {
		const gitDirectory = (process.env.PATH ?? "")
			.split(delimiter)
			.find((directory) => existsSync(join(directory, "git.exe")));
		if (!gitDirectory) throw new Error("git executable not found for the e2e host");
		if (
			["pi", "central", "code"].some((command) =>
				["", ".exe", ".cmd", ".bat"].some((suffix) =>
					existsSync(join(gitDirectory, command + suffix)),
				),
			)
		)
			throw new Error("e2e git directory must not contain production agent or editor executables");
		return [fakeBinDir, gitDirectory].join(delimiter);
	}
	return [fakeBinDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
}

export function hermeticE2eShell(fakeBinDir: string): string {
	if (process.platform === "win32") return gitBashExecutable(fakeBinDir);
	return fixtureExecutable(fakeBinDir, "login-shell");
}

export function fixtureExecutable(fakeBinDir: string, name: string): string {
	return join(fakeBinDir, process.platform === "win32" ? `${name}.exe` : name);
}

function gitBashExecutable(fakeBinDir: string): string {
	const gitDirectory = hermeticE2ePath(fakeBinDir).split(delimiter)[1];
	if (!gitDirectory) throw new Error("Missing Git directory for fixture shell");
	const shell = [
		resolve(gitDirectory, "..", "usr", "bin", "bash.exe"),
		join(gitDirectory, "bash.exe"),
		resolve(gitDirectory, "..", "bin", "bash.exe"),
	].find(existsSync);
	if (!shell) throw new Error("Git Bash is required for Windows POSIX fixtures");
	return shell;
}

function writeFixtureExecutable(fakeBinDir: string, name: string, source: string): void {
	const target = fixtureExecutable(fakeBinDir, name);
	if (process.platform !== "win32") {
		writeFileSync(target, source, { mode: 0o755 });
		return;
	}
	const launcher = join(fakeBinDir, "fixture-shim.exe");
	if (!existsSync(launcher)) {
		writeFileSync(
			join(fakeBinDir, "fixture-shim.json"),
			JSON.stringify({ shell: gitBashExecutable(fakeBinDir) }),
		);
		const result = spawnSync(
			resolveBunExecutable(),
			[
				"build",
				"--compile",
				fileURLToPath(new URL("./windowsShim.ts", import.meta.url)),
				"--outfile",
				launcher,
			],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);
		if (result.status !== 0)
			throw new Error(`Could not build Windows fixture launcher: ${result.stderr}`);
	}
	writeFileSync(join(fakeBinDir, `${name}.sh`), source);
	if (existsSync(target)) unlinkSync(target);
	linkSync(launcher, target);
}

export function writeFixtureCommand(
	fakeBinDir: string,
	name: "central" | "code" | "github-ssh",
): void {
	writeFixtureExecutable(
		fakeBinDir,
		name,
		readFileSync(new URL(`./bin/${name}`, import.meta.url), "utf8"),
	);
}

export function writeHermeticE2eShell(fakeBinDir: string, realShell: string): void {
	if (process.platform === "win32") return;
	const script = [
		"#!/bin/sh",
		'case "$*" in',
		`\t*${shellQuote(LOGIN_ENV_MARKER)}*) printf '%sPATH=%s\\0' ${shellQuote(LOGIN_ENV_MARKER)} ${shellQuote(hermeticE2ePath(fakeBinDir))}; exit 0 ;;`,
		"esac",
		`exec ${shellQuote(realShell)} "$@"`,
		"",
	].join("\n");
	writeFixtureExecutable(fakeBinDir, "login-shell", script);
}

export function writeFakeGh(fakeBinDir: string, scenarioPath: string, logPath: string): void {
	const source = fileURLToPath(new URL("./fakeGh.ts", import.meta.url));
	const script = [
		"#!/bin/sh",
		`exec ${[resolveBunExecutable(), source, scenarioPath, logPath].map(shellQuote).join(" ")} "$@"`,
		"",
	].join("\n");
	writeFixtureExecutable(fakeBinDir, "gh", script);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
