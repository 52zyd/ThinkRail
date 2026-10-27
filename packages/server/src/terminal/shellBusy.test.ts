import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun-pty";
import { hasChildProcesses, parseProcChildren, WINDOWS_CHILD_COUNT } from "./shellBusy";

describe("parseProcChildren", () => {
	test("reads the pid list", () => {
		expect(parseProcChildren("1234 5678 91011\n")).toEqual([1234, 5678, 91011]);
	});

	test("no children is an empty file, not an absent one", () => {
		expect(parseProcChildren("")).toEqual([]);
		expect(parseProcChildren("\n")).toEqual([]);
	});

	test("ignores anything that is not a pid", () => {
		expect(parseProcChildren("12 junk -3 0 34")).toEqual([12, 34]);
	});
});

describe("hasChildProcesses", () => {
	test("a shell running something reports busy; a bare process does not", async () => {
		const withChild = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
console.log(child.pid);
process.stdin.once("data", async () => { child.kill(); await child.exited; process.exit(0); });
setInterval(() => {}, 1000);
`,
			],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const withoutChild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		const savedPath = process.env.PATH;
		try {
			await withChild.stdout.getReader().read();
			if (process.platform === "win32") process.env.PATH = "";
			expect(hasChildProcesses(withChild.pid)).toBe(true);
			expect(hasChildProcesses(withoutChild.pid)).toBe(false);
		} finally {
			process.env.PATH = savedPath;
			withChild.stdin.write("stop");
			await withChild.exited;
			withoutChild.kill();
			await withoutChild.exited;
		}
	});

	test("an implausible pid is not busy rather than throwing", () => {
		expect(hasChildProcesses(0)).toBe(false);
		expect(hasChildProcesses(-1)).toBe(false);
		expect(hasChildProcesses(Number.NaN)).toBe(false);
	});

	test("a pid that no longer exists is not busy", () => {
		const gone = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
		gone.kill();
		expect(hasChildProcesses(gone.pid)).toBe(false);
	});
});

describe("the Windows probe", () => {
	test.skipIf(process.platform !== "win32" || !existsSync("C:/Program Files/Git/usr/bin/bash.exe"))(
		"a Git Bash PTY detects MSYS children and returns to idle after interruption",
		async () => {
			const fixture = mkdtempSync(join(tmpdir(), "thinkrail-busy-msys-"));
			const terminal = spawn("C:/Program Files/Git/usr/bin/bash.exe", ["--noprofile", "--norc"], {
				name: "xterm-256color",
				cwd: fixture,
				cols: 80,
				rows: 24,
				env: { ...process.env, HOME: fixture, USERPROFILE: fixture },
			});
			let output = "";
			terminal.onData((data) => {
				output += data;
			});
			try {
				terminal.write("printf TR_BUSY_%s READY; /usr/bin/sleep 30\r");
				const deadline = Date.now() + 5000;
				while (!output.includes("TR_BUSY_READY") && Date.now() < deadline) await Bun.sleep(20);
				expect(output).toContain("TR_BUSY_READY");
				expect(hasChildProcesses(terminal.pid)).toBe(true);
				terminal.write("\u0003");
				const stopped = Date.now() + 5000;
				while (hasChildProcesses(terminal.pid) && Date.now() < stopped) await Bun.sleep(20);
				expect(hasChildProcesses(terminal.pid)).toBe(false);
			} finally {
				terminal.write("\u0003");
				terminal.kill();
				rmSync(fixture, { recursive: true, force: true });
			}
		},
		15_000,
	);

	test("passes the pid by environment, never by string interpolation", () => {
		expect(WINDOWS_CHILD_COUNT).toContain("$env:TR_PARENT_PID");
		expect(WINDOWS_CHILD_COUNT).not.toMatch(/ParentProcessId=\d/);
	});

	test("prints a count rather than relying on the exit code", () => {
		expect(WINDOWS_CHILD_COUNT).toContain("Write-Output");
		expect(WINDOWS_CHILD_COUNT).toContain("$ErrorActionPreference = 'Stop'");
	});
});
