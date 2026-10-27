import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const directory = dirname(process.execPath);
const command = basename(process.execPath, ".exe");
const config: { shell: string } = JSON.parse(
	readFileSync(join(directory, "fixture-shim.json"), "utf8"),
);
const script = join(directory, `${command}.sh`).replaceAll("\\", "/");
if (!existsSync(script)) throw new Error(`Unknown fixture command: ${command}`);

function shellPath(value: string): string {
	return value
		.replaceAll("\\", "/")
		.replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`);
}

const env = { ...process.env };
for (const name of [
	"HOME",
	"CENTRAL_STUB_STATE",
	"CENTRAL_STUB_LOG",
	"CENTRAL_STUB_EXTENSION_SOURCE",
	"CENTRAL_STUB_BAD_EXTENSION_SOURCE",
	"THINKRAIL_E2E_EDITOR_LOG",
]) {
	const value = env[name];
	if (value !== undefined) env[name] = shellPath(value);
}
const pathName = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
env[pathName] = `${(env[pathName] ?? "").split(";").map(shellPath).join(":")}:/usr/bin:/bin`;
const result = Bun.spawnSync([config.shell, script, ...process.argv.slice(2)], {
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
	env,
});
process.exit(result.exitCode);
