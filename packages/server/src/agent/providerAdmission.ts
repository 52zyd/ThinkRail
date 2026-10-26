import { CodedError } from "@thinkrail/shared/codedError";

export const COMPATIBLE_PROVIDER_PREFIX = "thinkrail-openai-";
const writing = new Set<string>();
const reservations = new Map<string, number>();

export function isCompatibleProviderId(id: string): boolean {
	return /^thinkrail-openai-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
		id,
	);
}

export function reserveModelProvider(id: string | undefined): () => void {
	if (!id || !isCompatibleProviderId(id)) return () => {};
	if (writing.has(id))
		throw new CodedError("COMPATIBLE_IN_USE", "Provider configuration is being updated.");
	reservations.set(id, (reservations.get(id) ?? 0) + 1);
	return () => {
		const remaining = (reservations.get(id) ?? 1) - 1;
		if (remaining === 0) reservations.delete(id);
		else reservations.set(id, remaining);
	};
}

export async function withProviderWrite<T>(
	id: string,
	assertIdle: () => void,
	operation: () => Promise<T>,
): Promise<T> {
	if (writing.has(id) || reservations.has(id))
		throw new CodedError(
			"COMPATIBLE_IN_USE",
			"Close associated chats before updating this provider.",
		);
	assertIdle();
	writing.add(id);
	try {
		return await operation();
	} finally {
		writing.delete(id);
	}
}
