import { RiAddLine, RiDeleteBin6Line, RiEditLine } from "@remixicon/react";
import type {
	CompatibleModelInput,
	CompatibleProvider,
	CompatibleProviderInput,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { type Translator, useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { Switch } from "@thinkrail/ui/switch";
import { useCallback, useEffect, useRef, useState } from "react";
import { randomId } from "@/lib";
import { useAppStore } from "@/store";
import { getTransport, wsErrorCode } from "@/transport";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingsGroup } from "./SettingsGroup";

const INPUT =
	"w-full min-w-0 rounded-sm border border-control-border-default bg-control-bg px-8 py-4 tr-text-ui text-text-default outline-none placeholder:text-text-muted focus-visible:border-control-border-active disabled:opacity-50";
const ERROR_KEYS: Record<string, MessageKey> = {
	COMPATIBLE_INVALID: "settings.compatible.invalid",
	COMPATIBLE_IN_USE: "settings.compatible.inUse",
	COMPATIBLE_CONFIG_FAILED: "settings.compatible.configFailed",
	COMPATIBLE_DISCOVERY_FAILED: "settings.compatible.discoveryFailed",
	COMPATIBLE_KEY_FAILED: "settings.compatible.keyFailed",
	COMPATIBLE_STALE: "settings.compatible.stale",
};

function failure(t: Translator, error: unknown): string {
	return t(ERROR_KEYS[wsErrorCode(error) ?? ""] ?? "settings.compatible.failed");
}

export function CompatibleProvidersSettings({ onChanged }: { onChanged: () => Promise<void> }) {
	const t = useT();
	const version = useAppStore((s) => s.providerVersion);
	const [providers, setProviders] = useState<CompatibleProvider[]>([]);
	const [editing, setEditing] = useState<CompatibleProvider | "new" | null>(null);
	const [removing, setRemoving] = useState<CompatibleProvider | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const sequence = useRef(0);
	const load = useCallback(async () => {
		const current = ++sequence.current;
		await getTransport()
			.request("provider.compatibleList", {})
			.then((next) => {
				if (sequence.current === current) {
					setProviders(next);
					setError("");
				}
			})
			.catch((error) => {
				if (sequence.current === current) setError(failure(t, error));
			})
			.finally(() => {
				if (sequence.current === current) setLoading(false);
			});
	}, [t]);
	useEffect(() => {
		void version;
		void load();
		return () => {
			sequence.current += 1;
		};
	}, [load, version]);
	const save = async (input: CompatibleProviderInput) => {
		await getTransport().request("provider.compatibleSave", input);
		setEditing(null);
		await load();
		await onChanged();
	};
	const remove = (provider: CompatibleProvider) => {
		setBusy(true);
		void getTransport()
			.request("provider.compatibleRemove", { id: provider.id, revision: provider.revision })
			.then(async () => {
				await load();
				await onChanged();
			})
			.catch((error) => setError(failure(t, error)))
			.finally(() => setBusy(false));
	};
	return (
		<SettingsGroup
			title={t("settings.compatible.title")}
			description={t("settings.compatible.description")}
			testId="compatible-providers"
		>
			{loading ? (
				<p className="py-12 tr-text-metadata text-text-muted">{t("common.loading")}</p>
			) : null}
			{error ? (
				<p role="alert" className="py-12 tr-text-metadata text-feedback-error">
					{error}
				</p>
			) : null}
			{providers.map((provider) => (
				<div
					key={provider.id}
					data-testid="compatible-provider"
					data-provider={provider.id}
					className="flex flex-wrap items-center gap-8 border-b border-border-muted py-12"
				>
					<div className="min-w-0 flex-1">
						<p className="break-words tr-text-ui text-text-default">{provider.name}</p>
						<p className="break-all tr-text-metadata text-text-muted">{provider.baseUrl}</p>
						<p className="tr-text-metadata text-text-muted">
							{t(
								provider.api === "openai-completions"
									? "settings.compatible.apiChat"
									: "settings.compatible.apiResponses",
							)}{" "}
							· {t(provider.hasKey ? "settings.compatible.keySaved" : "settings.compatible.noKey")}
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						data-testid="compatible-edit"
						disabled={busy || editing !== null}
						onClick={() => setEditing(provider)}
					>
						<RiEditLine className="size-14" />
						{t("common.edit")}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						data-testid="compatible-remove"
						disabled={busy || editing !== null}
						aria-label={t("settings.compatible.remove", { name: provider.name })}
						onClick={() => setRemoving(provider)}
					>
						<RiDeleteBin6Line className="size-14" />
					</Button>
				</div>
			))}
			{editing ? (
				<CompatibleProviderForm
					key={editing === "new" ? "new" : editing.id}
					provider={editing === "new" ? undefined : editing}
					onSave={save}
					onCancel={() => setEditing(null)}
				/>
			) : (
				<div className="py-12">
					<Button
						variant="outline"
						size="sm"
						data-testid="compatible-add"
						disabled={busy || loading}
						onClick={() => setEditing("new")}
					>
						<RiAddLine className="size-14" />
						{t("settings.compatible.add")}
					</Button>
				</div>
			)}
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open) setRemoving(null);
				}}
				title={t("settings.compatible.removeTitle")}
				description={t("settings.compatible.removeDescription", { name: removing?.name ?? "" })}
				confirmLabel={t("common.delete")}
				confirmTestId="compatible-remove-confirm"
				destructive
				onConfirm={() => {
					if (removing) remove(removing);
				}}
			/>
		</SettingsGroup>
	);
}

type ModelDraft = CompatibleModelInput & { rowId: string };
const newModel = (model: CompatibleModelInput = { id: "" }): ModelDraft => ({
	...model,
	rowId: randomId(),
});

export function CompatibleProviderForm({
	provider,
	onSave,
	onCancel,
}: {
	provider?: CompatibleProvider | undefined;
	onSave: (input: CompatibleProviderInput) => Promise<void>;
	onCancel: () => void;
}) {
	const t = useT();
	const [name, setName] = useState(provider?.name ?? "");
	const [url, setUrl] = useState(provider?.baseUrl ?? "");
	const [api, setApi] = useState<CompatibleProviderInput["api"]>(
		provider?.api ?? "openai-completions",
	);
	const [key, setKey] = useState("");
	const [noKey, setNoKey] = useState(provider ? !provider.hasKey : true);
	const [models, setModels] = useState<ModelDraft[]>(
		provider?.models.map(newModel) ?? [newModel()],
	);
	const [discovered, setDiscovered] = useState<string[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const update = (rowId: string, patch: Partial<CompatibleModelInput>) =>
		setModels((rows) => rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)));
	const secret = noKey ? null : key || undefined;
	const requestKey = secret === undefined ? {} : { apiKey: secret };
	const valid =
		name.trim() &&
		url.trim() &&
		models.length > 0 &&
		models.every((m) => m.id.trim()) &&
		(noKey || key || provider?.hasKey);
	const discover = () => {
		setBusy(true);
		setError("");
		void getTransport()
			.request("provider.compatibleDiscover", {
				...(provider ? { id: provider.id } : {}),
				baseUrl: url,
				...requestKey,
			})
			.then((ids) => setDiscovered(ids))
			.catch((error) => setError(failure(t, error)))
			.finally(() => setBusy(false));
	};
	const submit = () => {
		setBusy(true);
		setError("");
		void onSave({
			...(provider ? { id: provider.id, revision: provider.revision } : {}),
			name,
			baseUrl: url,
			api,
			models: models.map(({ rowId: _rowId, ...model }) => model),
			...requestKey,
		})
			.catch((error) => setError(failure(t, error)))
			.finally(() => {
				setBusy(false);
			});
	};
	return (
		<form
			data-testid="compatible-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (valid && !busy) submit();
			}}
			className="flex flex-col gap-12 py-12"
		>
			<fieldset disabled={busy} className="flex min-w-0 flex-col gap-12">
				<label className="flex flex-col gap-4 tr-text-ui text-text-default">
					{t("settings.compatible.name")}
					<input
						className={INPUT}
						data-testid="compatible-name"
						value={name}
						maxLength={256}
						required
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<label className="flex flex-col gap-4 tr-text-ui text-text-default">
					{t("settings.compatible.url")}
					<input
						type="url"
						className={INPUT}
						data-testid="compatible-url"
						placeholder={t("settings.compatible.urlPlaceholder")}
						value={url}
						maxLength={2048}
						required
						onChange={(event) => {
							setUrl(event.target.value);
							setDiscovered([]);
						}}
					/>
				</label>
				<p className="tr-text-metadata text-text-muted">{t("settings.compatible.urlHint")}</p>
				<label className="flex flex-col gap-4 tr-text-ui text-text-default">
					{t("settings.compatible.api")}
					<select
						className={INPUT}
						data-testid="compatible-api"
						value={api}
						onChange={(event) => {
							if (
								event.target.value === "openai-completions" ||
								event.target.value === "openai-responses"
							)
								setApi(event.target.value);
						}}
					>
						<option value="openai-completions">{t("settings.compatible.apiChat")}</option>
						<option value="openai-responses">{t("settings.compatible.apiResponses")}</option>
					</select>
				</label>
				<div className="flex items-center justify-between gap-12 tr-text-ui text-text-default">
					<span>{t("settings.compatible.noKey")}</span>
					<Switch
						testId="compatible-no-key"
						label={t("settings.compatible.noKey")}
						checked={noKey}
						onCheckedChange={(next) => {
							setNoKey(next);
							setKey("");
						}}
					/>
				</div>
				{!noKey ? (
					<label className="flex flex-col gap-4 tr-text-ui text-text-default">
						{t("settings.compatible.key")}
						<input
							type="password"
							autoComplete="new-password"
							className={INPUT}
							data-testid="compatible-key"
							value={key}
							maxLength={8192}
							placeholder={provider?.hasKey ? t("settings.compatible.keepKey") : undefined}
							onChange={(event) => setKey(event.target.value)}
						/>
					</label>
				) : null}
				<p className="tr-text-metadata text-text-muted">{t("settings.compatible.keyHint")}</p>
				<div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						data-testid="compatible-discover"
						disabled={!url.trim()}
						onClick={discover}
					>
						{t("settings.compatible.discover")}
					</Button>
				</div>
				{discovered.length ? (
					<label className="flex flex-col gap-4 tr-text-ui text-text-default">
						{t("settings.compatible.chooseModel")}
						<select
							className={INPUT}
							data-testid="compatible-discovered"
							value=""
							onChange={(event) => {
								const id = event.target.value;
								if (!id || models.some((model) => model.id === id)) return;
								setModels((rows) => [...rows.filter((row) => row.id.trim()), newModel({ id })]);
							}}
						>
							<option value="">{t("settings.compatible.chooseModel")}</option>
							{discovered.map((id) => (
								<option key={id} value={id}>
									{id}
								</option>
							))}
						</select>
					</label>
				) : null}
				{models.map((model) => (
					<div
						key={model.rowId}
						data-testid="compatible-model"
						className="flex min-w-0 flex-col gap-8 border-t border-border-muted pt-12"
					>
						<div className="flex items-end gap-8">
							<label className="flex min-w-0 flex-1 flex-col gap-4 tr-text-ui text-text-default">
								{t("settings.compatible.modelId")}
								<input
									className={INPUT}
									data-testid="compatible-model-id"
									value={model.id}
									required
									maxLength={256}
									onChange={(event) => update(model.rowId, { id: event.target.value })}
								/>
							</label>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label={t("settings.compatible.removeModel")}
								disabled={models.length === 1}
								onClick={() => setModels((rows) => rows.filter((row) => row.rowId !== model.rowId))}
							>
								<RiDeleteBin6Line className="size-14" />
							</Button>
						</div>
						<details>
							<summary className="cursor-pointer tr-text-metadata text-text-muted">
								{t("settings.compatible.advanced")}
							</summary>
							<div className="flex flex-col gap-8 pt-8">
								{(["contextWindow", "maxTokens"] as const).map((field) => (
									<label key={field} className="flex flex-col gap-4 tr-text-ui text-text-default">
										{t(
											field === "contextWindow"
												? "settings.compatible.context"
												: "settings.compatible.maxOutput",
										)}
										<input
											className={INPUT}
											type="number"
											min={1}
											step={1}
											data-testid={`compatible-${field}`}
											value={model[field] ?? ""}
											onChange={(event) =>
												update(model.rowId, {
													[field]: event.target.value ? Number(event.target.value) : undefined,
												})
											}
										/>
									</label>
								))}
								<label className="flex items-center gap-8 tr-text-ui text-text-default">
									<input
										type="checkbox"
										checked={model.reasoning ?? false}
										onChange={(event) => update(model.rowId, { reasoning: event.target.checked })}
									/>
									{t("settings.compatible.reasoning")}
								</label>
								<label className="flex items-center gap-8 tr-text-ui text-text-default">
									<input
										type="checkbox"
										checked={model.imageInput ?? false}
										onChange={(event) => update(model.rowId, { imageInput: event.target.checked })}
									/>
									{t("settings.compatible.images")}
								</label>
								<p className="tr-text-metadata text-text-muted">
									{t("settings.compatible.advancedHint")}
								</p>
							</div>
						</details>
					</div>
				))}
				<div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						data-testid="compatible-add-model"
						onClick={() => setModels((rows) => [...rows, newModel()])}
					>
						{t("settings.compatible.addModel")}
					</Button>
				</div>
			</fieldset>
			{error ? (
				<p role="alert" className="tr-text-metadata text-feedback-error">
					{error}
				</p>
			) : null}
			<p className="tr-text-metadata text-text-muted">{t("settings.compatible.inUseHint")}</p>
			<div className="flex flex-wrap gap-8">
				<Button type="submit" data-testid="compatible-save" disabled={!valid || busy}>
					{t(busy ? "common.loading" : "common.save")}
				</Button>
				<Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
					{t("common.cancel")}
				</Button>
			</div>
		</form>
	);
}
