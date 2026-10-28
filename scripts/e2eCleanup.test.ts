import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeFixtureTree } from "../e2e/fixtures/cleanup";

test("fixture cleanup removes link entries while preserving their external targets", () => {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-e2e-cleanup-"));
	const target = mkdtempSync(join(tmpdir(), "thinkrail-link-target-"));
	const marker = join(target, "preserve.txt");
	writeFileSync(marker, "keep the target\n");
	mkdirSync(join(root, "home"));
	symlinkSync(
		target,
		join(root, "home", "cache-link"),
		process.platform === "win32" ? "junction" : "dir",
	);
	try {
		removeFixtureTree(root);
		expect(existsSync(root)).toBe(false);
		expect(readFileSync(marker, "utf8")).toBe("keep the target\n");
	} finally {
		removeFixtureTree(root);
		rmSync(target, { recursive: true, force: true });
	}
});

test("fixture cleanup refuses an unrelated temporary directory", () => {
	const root = mkdtempSync(join(tmpdir(), "other-cleanup-root-"));
	try {
		expect(() => removeFixtureTree(root)).toThrow("named ThinkRail E2E temporary root");
		expect(existsSync(root)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fixture cleanup removes paths longer than the Windows legacy path limit", () => {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-e2e-cleanup-"));
	const nested = join(root, "long-directory-".repeat(9), "nested-directory-".repeat(9));
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "fixture.txt"), "remove the fixture\n");
	try {
		removeFixtureTree(root);
		expect(existsSync(root)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
