import {
	accessSync,
	constants,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CodedError } from "@thinkrail/shared/codedError";
import { applyEdits, modify, type Node, type ParseError, parseTree } from "jsonc-parser";

export const MODELS_PARSE = { allowTrailingComma: true };
export const MODELS_FORMAT = {
	formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
};
export const EMPTY_MODELS_CONFIG = '{\n  "providers": {}\n}\n';
let saving: Promise<unknown> = Promise.resolve();
let publisher: (() => void) | null = null;

export function setModelContextPublisher(next: (() => void) | null): void {
	publisher = next;
}

export function publishModelsChanged(): void {
	publisher?.();
}

export function serializeModelsSave<T>(operation: () => Promise<T>): Promise<T> {
	const run = saving.catch(() => undefined).then(operation);
	saving = run;
	return run;
}

export function modelsPath(): string {
	return join(getAgentDir(), "models.json");
}

export function readModelsSource(path = modelsPath()): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new CodedError("COMPATIBLE_CONFIG_FAILED", "Couldn't read pi's models.json.");
	}
}

export function parseModelsConfig(source: string | undefined): Node | undefined {
	if (source === undefined) return undefined;
	const errors: ParseError[] = [];
	const root = parseTree(source.replace(/^\uFEFF/, ""), errors, MODELS_PARSE);
	if (errors.length > 0 || root?.type !== "object")
		throw new CodedError("COMPATIBLE_CONFIG_FAILED", "Pi's models.json isn't valid JSON.");
	return root;
}

export function editModelsSource(
	source: string | undefined,
	path: (string | number)[],
	value: unknown,
): string {
	const bom = source?.startsWith("\uFEFF") ? "\uFEFF" : "";
	const body = source === undefined ? EMPTY_MODELS_CONFIG : source.slice(bom.length);
	return bom + applyEdits(body, modify(body, path, value, MODELS_FORMAT));
}

function resolveModelsFile(path: string): string {
	try {
		return realpathSync(path);
	} catch {}
	const seen = new Set<string>();
	let current = path;
	while (!seen.has(current)) {
		seen.add(current);
		try {
			current = resolve(dirname(current), readlinkSync(current));
		} catch {
			return current;
		}
	}
	throw new CodedError("COMPATIBLE_CONFIG_FAILED", "Couldn't resolve pi's models.json.");
}

export function writeModelsFile(path: string, source: string, expected: string | undefined): void {
	const target = resolveModelsFile(path);
	const temp = join(dirname(target), `.models.json.${process.pid}.tmp`);
	try {
		if (readModelsSource(path) !== expected)
			throw new CodedError("COMPATIBLE_STALE", "Pi's models.json changed; reload and retry.");
		let mode = 0o600;
		try {
			const existing = statSync(target);
			accessSync(target, constants.W_OK);
			if (!(existing.mode & 0o222)) throw new Error("Read-only models file");
			mode = existing.mode & 0o777;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		}
		writeFileSync(temp, source, { mode, flag: "wx" });
		if (resolveModelsFile(path) !== target || readModelsSource(path) !== expected)
			throw new CodedError("COMPATIBLE_STALE", "Pi's models.json changed; reload and retry.");
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		if (error instanceof CodedError) throw error;
		throw new CodedError("COMPATIBLE_CONFIG_FAILED", "Couldn't save pi's models.json.");
	}
}
