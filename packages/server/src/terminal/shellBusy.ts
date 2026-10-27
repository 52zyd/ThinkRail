import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSyncCaptured } from "@thinkrail/shared/spawn";

export function parseProcChildren(contents: string): number[] {
	return contents
		.split(/\s+/)
		.map((entry) => Number.parseInt(entry, 10))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

function childrenViaProc(pid: number): boolean | null {
	try {
		return parseProcChildren(readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")).length > 0;
	} catch {
		return null;
	}
}

function childrenViaPgrep(pid: number): boolean | null {
	const run = spawnSyncCaptured(["pgrep", "-P", String(pid)]);
	if (!run.launched) return null;
	if (run.exitCode === 0) return true;
	if (run.exitCode === 1) return false;
	return null;
}

export const WINDOWS_CHILD_COUNT = [
	"$ErrorActionPreference = 'Stop'",
	'$processes = @(Get-CimInstance Win32_Process -Filter "ProcessId=$env:TR_PARENT_PID OR ParentProcessId=$env:TR_PARENT_PID")',
	"$shellProcess = $processes | Where-Object { $_.ProcessId -eq $env:TR_PARENT_PID }",
	"$kids = @($processes | Where-Object { $_.ParentProcessId -eq $env:TR_PARENT_PID })",
	"$kids = @($kids | Where-Object { $_.Name -notin @('conhost.exe', 'OpenConsole.exe') })",
	"if ($shellProcess.Name -eq 'bash.exe' -and $shellProcess.ExecutablePath) {",
	"$msysPs = Join-Path (Split-Path -Parent $shellProcess.ExecutablePath) 'ps.exe'",
	"if (Test-Path -LiteralPath $msysPs) {",
	"$rows = @(& $msysPs -W | ForEach-Object { if ($_ -match '^\\s*(\\d+)\\s+(\\d+)\\s+\\d+\\s+(\\d+)\\s') { [pscustomobject]@{ MsysId=$Matches[1]; ParentId=$Matches[2]; NativeId=$Matches[3] } } })",
	"$msysShell = $rows | Where-Object { $_.NativeId -eq $env:TR_PARENT_PID }",
	"if ($msysShell) { $kids += @($rows | Where-Object { $_.ParentId -eq $msysShell.MsysId }) }",
	"}",
	"}",
	"Write-Output $kids.Count",
].join("; ");

function childrenViaCim(pid: number): boolean | null {
	const systemShell = process.env.SystemRoot
		? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		: undefined;
	for (const shell of [...(systemShell ? [systemShell] : []), "powershell.exe", "pwsh.exe"]) {
		const run = spawnSyncCaptured([shell, "-NoProfile", "-Command", WINDOWS_CHILD_COUNT], {
			env: { ...process.env, TR_PARENT_PID: String(pid) },
		});
		if (!run.launched || run.exitCode !== 0) continue;
		const count = Number.parseInt(run.stdout.trim(), 10);
		if (Number.isInteger(count)) return count > 0;
	}
	return null;
}

export function hasChildProcesses(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (process.platform === "win32") return childrenViaCim(pid) ?? false;
	return childrenViaProc(pid) ?? childrenViaPgrep(pid) ?? false;
}
