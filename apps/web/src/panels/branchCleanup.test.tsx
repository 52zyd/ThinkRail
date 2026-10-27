import { expect, test } from "bun:test";
import type { BranchCleanupEntry } from "@thinkrail/contracts";
import { applyLocale } from "@thinkrail/locales/react";
import { renderToStaticMarkup } from "react-dom/server";
import { BranchDeleteFields } from "./BranchDeleteFields";
import {
	branchDeletionInput,
	canConfirmBranchDeletion,
	supportsBranchCleanup,
} from "./branchCleanup";

const branch: BranchCleanupEntry = {
	name: "feature/keep",
	oid: "a".repeat(40),
	unmergedCommits: 2,
	worktreePaths: [],
};

test("cleanup needs a known v93 host and exact unmerged confirmation", () => {
	expect(supportsBranchCleanup(null)).toBe(false);
	expect(supportsBranchCleanup(92)).toBe(false);
	expect(supportsBranchCleanup(93)).toBe(true);
	for (const name of ["", "keep", " feature/keep", "feature/keep "])
		expect(canConfirmBranchDeletion(branch, name)).toBe(false);
	expect(canConfirmBranchDeletion(branch, branch.name)).toBe(true);
	expect(canConfirmBranchDeletion({ ...branch, unmergedCommits: 0 }, "")).toBe(true);
});

test("deletion carries the preview identities and explicit risk choice only for unmerged commits", () => {
	const list = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), branches: [branch] };
	expect(branchDeletionInput(list, branch, branch.name)).toEqual({
		name: branch.name,
		oid: branch.oid,
		baseRef: list.baseRef,
		baseOid: list.baseOid,
		allowUnmerged: true,
		confirmName: branch.name,
	});
	const merged = branchDeletionInput(list, { ...branch, unmergedCommits: 0 }, "");
	expect(merged).not.toHaveProperty("allowUnmerged");
	expect(merged).not.toHaveProperty("confirmName");
});

test("risk copy, branch identity and labeled confirmation render in English and Chinese", () => {
	try {
		for (const locale of ["en", "zh-CN"] as const) {
			applyLocale(locale, {});
			const markup = renderToStaticMarkup(
				<BranchDeleteFields
					branch={branch}
					baseRef="refs/heads/main"
					confirmName=""
					onConfirmNameChange={() => {}}
				/>,
			);
			expect(markup).toContain(branch.name);
			expect(markup).toContain('data-testid="branch-delete-name"');
			expect(markup).toContain("<label");
			expect(markup).toContain(
				locale === "en" ? "Unmerged commits may be lost" : "未合并提交可能丢失",
			);
		}
	} finally {
		applyLocale("en", {});
	}
});
