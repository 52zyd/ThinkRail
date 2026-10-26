import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./persistence";

let root: string;
let prior: string | undefined;
beforeEach(() => {
	prior = process.env.THINKRAIL_DATA_DIR;
	root = mkdtempSync(join(tmpdir(), "thinkrail-locale-"));
	process.env.THINKRAIL_DATA_DIR = root;
});
afterEach(() => {
	if (prior === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = prior;
	rmSync(root, { recursive: true, force: true });
});

test("new and missing preferences default to Chinese without replacing explicit choices", () => {
	expect(loadConfig().locale).toBe("zh-CN");
	writeFileSync(join(root, "config.json"), JSON.stringify({ analyticsEnabled: false }));
	expect(loadConfig().locale).toBe("zh-CN");
	for (const locale of ["en", "system", "zh-CN"]) {
		saveConfig({ ...loadConfig(), locale });
		expect(loadConfig().locale).toBe(locale);
	}
});
