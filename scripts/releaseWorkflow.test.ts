import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
	new URL("../.github/workflows/release-windows.yml", import.meta.url),
	"utf8",
);

test("Windows publication requires Linux full units and native Windows verification", () => {
	const units = workflow.split("  verify-units:\n")[1]?.split("  build:\n")[0] ?? "";
	const build = workflow.split("  build:\n")[1]?.split("  publish:\n")[0] ?? "";
	const publish = workflow.split("  publish:\n")[1] ?? "";
	expect(units).toContain("runs-on: ubuntu-latest");
	expect(units).toContain("run: bun run test");
	expect(build).toContain("needs: verify-units");
	expect(build).toContain("runs-on: windows-latest");
	expect(build).toContain("run: bun run test:windows-paths");
	expect(build).toContain("packages/server/src/subprocess");
	expect(build).toContain("packages/server/src/host/branchCleanup.test.ts");
	expect(build).toContain("packages/server/src/terminal");
	expect(build).toContain("run: bun run e2e");
	expect(build).not.toContain("run: bun run test\n");
	expect(publish).toContain("needs: build");
});
