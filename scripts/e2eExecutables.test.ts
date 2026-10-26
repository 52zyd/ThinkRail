import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { hermeticE2ePath } from "../e2e/fixtures/executables";

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
