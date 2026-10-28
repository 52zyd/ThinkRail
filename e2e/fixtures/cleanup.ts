import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, toNamespacedPath } from "node:path";
import { removeTree } from "@thinkrail/shared/removeTree";

const REMOVE_REPARSE_ENTRIES = [
	"$ErrorActionPreference = 'Stop'",
	"$root = $env:THINKRAIL_FIXTURE_ROOT",
	"if ([IO.File]::GetAttributes($root) -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture root must not be a reparse entry' }",
	"$queue = [Collections.Generic.Stack[string]]::new()",
	"$queue.Push($root)",
	"while ($queue.Count -gt 0) {",
	"foreach ($path in [IO.Directory]::GetFileSystemEntries($queue.Pop())) {",
	"$attributes = [IO.File]::GetAttributes($path)",
	"if ($attributes -band [IO.FileAttributes]::ReparsePoint) {",
	"if ($attributes -band [IO.FileAttributes]::Directory) { [IO.Directory]::Delete($path, $false) } else { [IO.File]::Delete($path) }",
	"} elseif ($attributes -band [IO.FileAttributes]::Directory) { $queue.Push($path) }",
	"}",
	"}",
].join("; ");

export function removeFixtureTree(path: string): void {
	const root = resolve(path);
	if (
		!basename(root).startsWith("thinkrail-e2e-") ||
		realpathSync.native(dirname(root)).toLowerCase() !== realpathSync.native(tmpdir()).toLowerCase()
	)
		throw new Error("Fixture cleanup requires a named ThinkRail E2E temporary root");
	if (!existsSync(root)) return;
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot;
		if (!systemRoot) throw new Error("Windows fixture cleanup requires SystemRoot");
		const result = spawnSync(
			join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			["-NoProfile", "-NonInteractive", "-Command", REMOVE_REPARSE_ENTRIES],
			{
				env: { ...process.env, THINKRAIL_FIXTURE_ROOT: toNamespacedPath(root) },
				encoding: "utf8",
				windowsHide: true,
			},
		);
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`Fixture reparse cleanup failed: ${result.stderr}`);
	}
	removeTree(root);
}
