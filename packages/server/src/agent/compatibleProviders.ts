import { createHash, randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	CompatibleModelInput,
	CompatibleProvider,
	CompatibleProviderInput,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { applyEdits, findNodeAtLocation, getNodeValue, type Node } from "jsonc-parser";
import { assertCompatibleProviderIdle, usePiRuntime } from "./agentSessionManager";
import {
	editModelsSource,
	modelsPath,
	parseModelsConfig,
	publishModelsChanged,
	readModelsSource,
	serializeModelsSave,
	writeModelsFile,
} from "./modelsConfig";
import {
	COMPATIBLE_PROVIDER_PREFIX,
	isCompatibleProviderId,
	withProviderWrite,
} from "./providerAdmission";

const NO_KEY = "thinkrail-no-auth";
const DISCOVERY_TIMEOUT_MS = 15_000;
const DISCOVERY_MAX_BYTES = 1_048_576;

function invalid(): never {
	throw new CodedError("COMPATIBLE_INVALID", "Invalid compatible-provider configuration.");
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
	return value as Record<string, unknown>;
}

function text(value: unknown, max = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || hasControls(value))
		return invalid();
	return value.trim();
}

function hasControls(value: string): boolean {
	return [...value].some((character) => character.charCodeAt(0) < 32);
}

function baseUrl(value: unknown): string {
	const raw = text(value, 2048);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return invalid();
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		/\/(?:models|responses|chat\/completions)\/?$/.test(url.pathname)
	)
		return invalid();
	return url.toString().replace(/\/+$/, "");
}

function modelInput(value: unknown): CompatibleModelInput {
	const raw = object(value);
	const model: CompatibleModelInput = { id: text(raw.id) };
	for (const field of ["contextWindow", "maxTokens"] as const) {
		const value = raw[field];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid();
		model[field] = value;
	}
	for (const field of ["reasoning", "imageInput"] as const) {
		if (raw[field] === undefined) continue;
		if (typeof raw[field] !== "boolean") return invalid();
		model[field] = raw[field];
	}
	if (model.contextWindow && model.maxTokens && model.maxTokens > model.contextWindow)
		return invalid();
	return model;
}

function validate(value: CompatibleProviderInput): CompatibleProviderInput {
	const raw = object(value);
	if (raw.api !== "openai-completions" && raw.api !== "openai-responses") return invalid();
	if (!Array.isArray(raw.models) || raw.models.length < 1 || raw.models.length > 500)
		return invalid();
	const models = raw.models.map(modelInput);
	if (new Set(models.map((m) => m.id)).size !== models.length) return invalid();
	if (raw.id !== undefined && (typeof raw.id !== "string" || !isCompatibleProviderId(raw.id)))
		return invalid();
	if (raw.id !== undefined && typeof raw.revision !== "string") return invalid();
	if (
		raw.apiKey !== undefined &&
		raw.apiKey !== null &&
		(typeof raw.apiKey !== "string" ||
			raw.apiKey.length === 0 ||
			raw.apiKey.length > 8192 ||
			hasControls(raw.apiKey))
	)
		return invalid();
	return {
		name: text(raw.name),
		baseUrl: baseUrl(raw.baseUrl),
		api: raw.api,
		models,
		...(typeof raw.id === "string" ? { id: raw.id, revision: text(raw.revision) } : {}),
		...(raw.apiKey !== undefined ? { apiKey: raw.apiKey as string | null } : {}),
	};
}

function providerNode(root: Node | undefined, id: string): Node | undefined {
	return root && findNodeAtLocation(root, ["providers", id]);
}

function configProvider(root: Node | undefined, id: string): Record<string, unknown> {
	const node = providerNode(root, id);
	if (node?.type !== "object") return invalid();
	return object(getNodeValue(node));
}

function revision(raw: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(raw)).digest("hex");
}

export function compatibleProviderIds(): string[] {
	const root = parseModelsConfig(readModelsSource());
	const providers = root && findNodeAtLocation(root, ["providers"]);
	if (!providers) return [];
	if (providers.type !== "object")
		throw new CodedError("COMPATIBLE_CONFIG_FAILED", "Invalid providers in pi's models.json.");
	return Object.keys(getNodeValue(providers)).filter(isCompatibleProviderId);
}

async function descriptor(
	runtime: ModelRuntime,
	root: Node | undefined,
	id: string,
): Promise<CompatibleProvider> {
	const raw = configProvider(root, id);
	if (!Array.isArray(raw.models)) return invalid();
	const config = validate({
		name: text(raw.name),
		baseUrl: baseUrl(raw.baseUrl),
		api: raw.api as CompatibleProviderInput["api"],
		models: raw.models.map((value) => {
			const entry = object(value);
			const override =
				root && findNodeAtLocation(root, ["providers", id, "modelOverrides", text(entry.id)]);
			const effective = { ...entry, ...(override ? object(getNodeValue(override)) : {}) };
			return modelInput({
				...effective,
				...(Array.isArray(effective.input)
					? { imageInput: effective.input.includes("image") }
					: {}),
			});
		}),
	});
	const credentials = await runtime.listCredentials();
	return {
		id,
		revision: revision(raw),
		name: config.name,
		baseUrl: config.baseUrl,
		api: config.api,
		models: config.models,
		hasKey:
			credentials.some((credential) => credential.providerId === id) ||
			(typeof raw.apiKey === "string" && raw.apiKey !== NO_KEY),
	};
}

export function listCompatibleProviders(): Promise<CompatibleProvider[]> {
	return usePiRuntime(async (runtime, generation) => {
		const source = readModelsSource();
		const root = parseModelsConfig(source);
		const providers = root && findNodeAtLocation(root, ["providers"]);
		if (!providers) return [];
		if (providers.type !== "object") return invalid();
		return Promise.all(
			Object.keys(getNodeValue(providers))
				.filter((id) => isCompatibleProviderId(id) && !generation.opaqueProviderIds.has(id))
				.map((id) => descriptor(runtime, root, id)),
		);
	});
}

async function storeKey(runtime: ModelRuntime, id: string, key: string): Promise<void> {
	const escaped = key.replaceAll("$", () => "$$");
	const literal = escaped.startsWith("!") ? `$${escaped}` : escaped;
	await runtime.login(id, "api_key", {
		notify: () => {},
		prompt: async (prompt) => {
			if (prompt.type !== "secret") throw new Error("Unexpected compatible-provider prompt");
			return literal;
		},
	});
}

async function assertPiConfigValid(runtime: ModelRuntime): Promise<void> {
	try {
		await runtime.refresh({ allowNetwork: false });
		if (runtime.getError()) throw new Error("Invalid pi model configuration");
	} catch {
		throw new CodedError("COMPATIBLE_CONFIG_FAILED", "Pi's model configuration is invalid.");
	}
}

export function saveCompatibleProvider(
	input: CompatibleProviderInput,
): Promise<CompatibleProvider> {
	const config = validate(input);
	const originalId = config.id ?? COMPATIBLE_PROVIDER_PREFIX + randomUUID();
	return serializeModelsSave(() =>
		withProviderWrite(
			originalId,
			() => assertCompatibleProviderIdle(originalId),
			() =>
				usePiRuntime(async (runtime, generation) => {
					if (generation.opaqueProviderIds.has(originalId)) return invalid();
					const source = readModelsSource();
					const root = parseModelsConfig(source);
					await assertPiConfigValid(runtime);
					const prior = config.id ? configProvider(root, originalId) : undefined;
					if (prior && revision(prior) !== config.revision)
						throw new CodedError("COMPATIBLE_STALE", "Provider changed; reload and retry.");
					const noKey =
						config.apiKey === null ||
						(config.apiKey === undefined &&
							(!prior ||
								(prior.apiKey === NO_KEY &&
									!(await runtime.listCredentials()).some((c) => c.providerId === originalId))));
					const routingChanged =
						prior && (prior.baseUrl !== config.baseUrl || prior.api !== config.api);
					const id = routingChanged ? COMPATIBLE_PROVIDER_PREFIX + randomUUID() : originalId;
					const retainedKey =
						routingChanged && !noKey && config.apiKey === undefined
							? (await runtime.getAuth(originalId))?.auth.apiKey
							: undefined;
					let next = source;
					if (routingChanged) {
						const key = providerNode(root, originalId)?.parent?.children?.[0];
						if (!key || source === undefined) return invalid();
						next = applyEdits(source, [
							{
								offset: key.offset + (source.startsWith("\uFEFF") ? 1 : 0),
								length: key.length,
								content: JSON.stringify(id),
							},
						]);
					}
					const fields: Record<string, unknown> = {
						name: config.name,
						baseUrl: config.baseUrl,
						api: config.api,
						models: config.models.map(({ imageInput, ...model }) => {
							const previous = Array.isArray(prior?.models)
								? prior.models.find((entry) => object(entry).id === model.id)
								: undefined;
							const {
								id: _id,
								contextWindow: _context,
								maxTokens: _max,
								reasoning: _reasoning,
								input: _input,
								baseUrl: _baseUrl,
								api: _api,
								headers: _headers,
								...extra
							} = previous ? object(previous) : {};
							return {
								...extra,
								...model,
								...(imageInput !== undefined
									? { input: imageInput ? ["text", "image"] : ["text"] }
									: {}),
							};
						}),
						apiKey: noKey
							? NO_KEY
							: typeof config.apiKey === "string" || retainedKey
								? undefined
								: prior?.apiKey,
					};
					for (const [field, value] of Object.entries(fields)) {
						if (JSON.stringify(prior?.[field]) === JSON.stringify(value)) continue;
						const previous = prior?.models;
						if (
							field === "models" &&
							Array.isArray(previous) &&
							Array.isArray(value) &&
							previous.length === value.length &&
							previous.every((model, index) => object(model).id === object(value[index]).id)
						) {
							for (const [index, model] of value.entries()) {
								const before = object(previous[index]);
								const after = object(model);
								for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
									if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
										next = editModelsSource(
											next,
											["providers", id, "models", index, key],
											after[key],
										);
								}
							}
							continue;
						}
						next = editModelsSource(next, ["providers", id, field], value);
					}
					for (const model of config.models) {
						for (const field of [
							"contextWindow",
							"maxTokens",
							"reasoning",
							"input",
							"baseUrl",
							"api",
							"headers",
						]) {
							if (
								!root ||
								!findNodeAtLocation(root, [
									"providers",
									originalId,
									"modelOverrides",
									model.id,
									field,
								])
							)
								continue;
							next = editModelsSource(
								next,
								["providers", id, "modelOverrides", model.id, field],
								undefined,
							);
						}
					}
					if (next === undefined) return invalid();
					writeModelsFile(modelsPath(), next, source);
					try {
						await runtime.refresh({ allowNetwork: false });
						if (!runtime.getProvider(id)) throw new Error("Provider failed to load");
						const key = config.apiKey ?? retainedKey;
						if (typeof key === "string") await storeKey(runtime, id, key);
						else if (noKey) await runtime.logout(id);
						if (routingChanged) await runtime.logout(originalId);
					} catch {
						publishModelsChanged();
						throw new CodedError(
							"COMPATIBLE_KEY_FAILED",
							"Configuration saved; couldn't synchronize pi credentials. Reload and retry.",
						);
					}
					publishModelsChanged();
					return descriptor(runtime, parseModelsConfig(next), id);
				}),
		),
	);
}

export function removeCompatibleProvider(id: string, expectedRevision: string): Promise<void> {
	if (typeof id !== "string" || !isCompatibleProviderId(id) || typeof expectedRevision !== "string")
		return invalid();
	return serializeModelsSave(() =>
		withProviderWrite(
			id,
			() => assertCompatibleProviderIdle(id),
			() =>
				usePiRuntime(async (runtime, generation) => {
					if (generation.opaqueProviderIds.has(id)) return invalid();
					const source = readModelsSource();
					const raw = configProvider(parseModelsConfig(source), id);
					await assertPiConfigValid(runtime);
					if (revision(raw) !== expectedRevision)
						throw new CodedError("COMPATIBLE_STALE", "Provider changed; reload and retry.");
					const next = editModelsSource(source, ["providers", id], undefined);
					writeModelsFile(modelsPath(), next, source);
					try {
						await runtime.logout(id);
						await runtime.refresh({ allowNetwork: false });
					} catch {
						throw new CodedError(
							"COMPATIBLE_KEY_FAILED",
							"Provider removed; couldn't synchronize pi credentials.",
						);
					} finally {
						publishModelsChanged();
					}
				}),
		),
	);
}

export async function discoverCompatibleModels(
	input: Pick<CompatibleProviderInput, "id" | "baseUrl" | "apiKey">,
): Promise<string[]> {
	const raw = object(input);
	const url = baseUrl(raw.baseUrl);
	if (
		raw.apiKey !== undefined &&
		raw.apiKey !== null &&
		(typeof raw.apiKey !== "string" || raw.apiKey.length > 8192 || hasControls(raw.apiKey))
	)
		return invalid();
	let placeholder = false;
	if (raw.id !== undefined) {
		if (typeof raw.id !== "string" || !isCompatibleProviderId(raw.id)) return invalid();
		const stored = configProvider(parseModelsConfig(readModelsSource()), raw.id);
		placeholder = stored.apiKey === NO_KEY;
		if (baseUrl(stored.baseUrl) !== url && raw.apiKey !== null && !raw.apiKey) return invalid();
	}
	try {
		let key = typeof raw.apiKey === "string" ? raw.apiKey : undefined;
		if (typeof raw.id === "string") {
			const id = raw.id;
			key = await usePiRuntime(async (runtime, generation) => {
				if (generation.opaqueProviderIds.has(id)) return invalid();
				return raw.apiKey === undefined ? (await runtime.getAuth(id))?.auth.apiKey : key;
			});
		}
		const response = await fetch(`${url}/models`, {
			headers:
				key && !(placeholder && raw.apiKey === undefined && key === NO_KEY)
					? { Authorization: `Bearer ${key}` }
					: {},
			redirect: "error",
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		});
		if (!response.ok || !response.body) throw new Error("Discovery failed");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.byteLength;
				if (size > DISCOVERY_MAX_BYTES) throw new Error("Model list too large");
				chunks.push(part.value);
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		const result = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		if (!Array.isArray(result.data)) throw new Error("Invalid model list");
		return [...new Set(result.data.map((entry) => text(object(entry).id)))].sort();
	} catch {
		throw new CodedError(
			"COMPATIBLE_DISCOVERY_FAILED",
			"Couldn't fetch models. Check the endpoint and key, or enter model IDs manually.",
		);
	}
}
