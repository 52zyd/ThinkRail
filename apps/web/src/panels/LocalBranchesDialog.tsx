import { RiGitBranchLine, RiRefreshLine } from "@remixicon/react";
import type { BranchCleanupEntry } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { LoadingRegion } from "@thinkrail/ui/skeleton";
import { useEffect, useRef, useState } from "react";
import { getTransport } from "../transport";
import { BranchDeleteFields } from "./BranchDeleteFields";
import {
	branchCleanupError,
	branchDeletionInput,
	canConfirmBranchDeletion,
	useBranchCleanupPreview,
} from "./branchCleanup";

export function LocalBranchesDialog({
	projectId,
	open,
	onOpenChange,
	onClosedAutoFocus,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onClosedAutoFocus: () => void;
}) {
	const t = useT();
	const preview = useBranchCleanupPreview(projectId, open, t("panels.branchCleanup.listFailed"));
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<BranchCleanupEntry | null>(null);
	const [confirmName, setConfirmName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const selectedTrigger = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) return;
		setSearch("");
		setSelected(null);
		setConfirmName("");
		setError(null);
	}, [open]);
	const refresh = () => {
		setSelected(null);
		setConfirmName("");
		setError(null);
		void preview.refresh();
	};
	const deleteSelected = async () => {
		if (
			!selected ||
			!preview.list ||
			busy ||
			selected.blockedReason ||
			!canConfirmBranchDeletion(selected, confirmName)
		)
			return;
		setBusy(true);
		setError(null);
		try {
			await getTransport().request("git.deleteBranch", {
				projectId,
				...branchDeletionInput(preview.list, selected, confirmName),
			});
			setSelected(null);
			setConfirmName("");
			await preview.refresh();
			if (searchRef.current) searchRef.current.focus();
		} catch (cause) {
			setError(branchCleanupError(cause, t("panels.branchCleanup.deleteFailed")));
		}
		setBusy(false);
	};
	const filtered =
		preview.list?.branches.filter((branch) =>
			branch.name.toLowerCase().includes(search.toLowerCase()),
		) ?? [];
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!busy) onOpenChange(next);
			}}
		>
			<DialogContent
				data-testid="local-branches-dialog"
				className="max-h-[90dvh] max-w-[36rem] overflow-y-auto"
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					onClosedAutoFocus();
				}}
			>
				<DialogHeader>
					<DialogTitle>{t("panels.branchCleanup.title")}</DialogTitle>
					<DialogDescription>{t("panels.branchCleanup.description")}</DialogDescription>
				</DialogHeader>
				<div className="flex items-center gap-8">
					<input
						ref={searchRef}
						className="w-full min-w-0 rounded-sm border border-control-border-default bg-control-bg px-8 py-4 text-text-default tr-text-ui outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-primary disabled:bg-control-disabled-bg disabled:text-control-disabled-text"
						aria-label={t("panels.branchCleanup.search")}
						placeholder={t("panels.branchCleanup.search")}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						readOnly={busy}
					/>
					<Button
						variant="outline"
						size="icon"
						aria-label={t("panels.branchCleanup.refresh")}
						onClick={refresh}
						disabled={busy || preview.loading}
					>
						<RiRefreshLine className="size-16" />
					</Button>
				</div>
				{preview.loading ? <LoadingRegion rows={3} /> : null}
				{preview.error ? (
					<p role="alert" className="break-words text-feedback-error tr-text-ui">
						{preview.error}
					</p>
				) : null}
				{preview.list ? (
					<div className="max-h-[35vh] overflow-y-auto" data-testid="branch-cleanup-list">
						{filtered.map((branch) => (
							<div
								key={branch.name}
								data-testid="branch-cleanup-row"
								data-branch={branch.name}
								className="flex min-w-0 items-start gap-8 border-border-muted border-b py-8"
							>
								<RiGitBranchLine className="mt-4 size-16 shrink-0 text-text-muted" />
								<div className="min-w-0 flex-1">
									<p className="break-words tr-text-ui">{branch.name}</p>
									<p className="text-text-muted tr-text-metadata">
										{t("panels.branchCleanup.unmerged", { count: branch.unmergedCommits })}
									</p>
									{branch.blockedReason ? (
										<p className="break-words text-text-subtle tr-text-metadata">
											{t(`panels.branchCleanup.blocked.${branch.blockedReason}`)}
										</p>
									) : null}
									{branch.worktreePaths.map((path) => (
										<p key={path} className="break-all text-text-subtle tr-text-metadata">
											{path}
										</p>
									))}
									{branch.workspaceNames?.length ? (
										<p className="break-words text-text-subtle tr-text-metadata">
											{branch.workspaceNames.join(", ")}
										</p>
									) : null}
								</div>
								<Button
									variant="outline"
									disabled={busy || !!branch.blockedReason}
									onClick={(event) => {
										selectedTrigger.current = event.currentTarget;
										setSelected(branch);
										setConfirmName("");
										setError(null);
									}}
								>
									{t("common.delete")}
								</Button>
							</div>
						))}
						{filtered.length === 0 ? (
							<p className="py-8 text-text-muted tr-text-ui">{t("panels.branchCleanup.empty")}</p>
						) : null}
					</div>
				) : null}
				{selected && preview.list ? (
					<BranchDeleteFields
						branch={selected}
						baseRef={preview.list.baseRef}
						confirmName={confirmName}
						onConfirmNameChange={setConfirmName}
						disabled={busy}
					/>
				) : null}
				{error ? (
					<p role="alert" className="break-words text-feedback-error tr-text-ui">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => {
							if (selected) {
								setSelected(null);
								setConfirmName("");
								setError(null);
								selectedTrigger.current?.focus();
							} else onOpenChange(false);
						}}
					>
						{t("common.cancel")}
					</Button>
					{selected ? (
						<Button
							className="h-auto min-h-32 whitespace-normal break-all py-4"
							variant="destructive"
							data-testid="confirm-delete-branch"
							disabled={busy || !canConfirmBranchDeletion(selected, confirmName)}
							onClick={() => void deleteSelected()}
						>
							{busy
								? t("panels.branchCleanup.deleting")
								: t("panels.branchCleanup.confirm", { branch: selected.name })}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
