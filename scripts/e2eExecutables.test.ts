import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	hermeticE2ePath,
	hermeticE2eShell,
	writeHermeticE2eShell,
} from "../e2e/fixtures/executables";

test("the browser host PATH exposes fixture tools and native Git, not the developer PATH", () => {
	const fake = join(process.cwd(), "fixture-bin");
	const paths = hermeticE2ePath(fake).split(delimiter);
	expect(paths[0]).toBe(fake);
	if (process.platform === "win32") {
		expect(paths).toHaveLength(2);
		expect(existsSync(join(paths[1] ?? "", "git.exe"))).toBe(true);
	} else {
		expect(paths.slice(1)).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
	}
});

test("the fixture shell executes through the hermetic native path", () => {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-native-fixture-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	try {
		writeHermeticE2eShell(bin, "/bin/bash");
		const result = Bun.spawnSync([hermeticE2eShell(bin), "-c", "printf TR_NATIVE_FIXTURE"], {
			env: { ...process.env, PATH: hermeticE2ePath(bin), HOME: root },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.stderr.toString()).toBe("");
		expect(result.success).toBe(true);
		expect(result.stdout.toString()).toBe("TR_NATIVE_FIXTURE");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
