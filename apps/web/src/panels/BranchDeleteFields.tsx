import type { BranchCleanupEntry } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { useEffect, useId, useRef } from "react";

export function BranchDeleteFields({
	branch,
	baseRef,
	confirmName,
	onConfirmNameChange,
	disabled = false,
}: {
	branch: BranchCleanupEntry;
	baseRef: string;
	confirmName: string;
	onConfirmNameChange: (name: string) => void;
	disabled?: boolean;
}) {
	const t = useT();
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	return (
		<div className="flex min-w-0 flex-col gap-8">
			<p className="break-words text-text-muted tr-text-ui">
				{t("panels.branchCleanup.comparison", {
					branch: branch.name,
					base: baseRef,
					count: branch.unmergedCommits,
				})}
			</p>
			{branch.unmergedCommits > 0 ? (
				<>
					<p className="text-feedback-warning tr-text-ui">{t("panels.branchCleanup.risk")}</p>
					<label htmlFor={inputId} className="break-words tr-text-ui">
						{t("panels.branchCleanup.typeName", { branch: branch.name })}
					</label>
					<input
						ref={inputRef}
						className="w-full min-w-0 rounded-sm border border-control-border-default bg-control-bg px-8 py-4 text-text-default tr-text-ui outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:bg-control-disabled-bg disabled:text-control-disabled-text"
						id={inputId}
						data-testid="branch-delete-name"
						value={confirmName}
						onChange={(event) => onConfirmNameChange(event.target.value)}
						disabled={disabled}
						autoComplete="off"
						spellCheck={false}
					/>
				</>
			) : null}
		</div>
	);
}
