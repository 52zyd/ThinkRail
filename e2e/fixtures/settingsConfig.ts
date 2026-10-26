import type { AppConfig } from "@thinkrail/contracts";
import { E2eWire } from "./wire";

export const ENGLISH_CONFIG = { locale: "en" };

export async function seedEnglishConfig(baseURL: string | undefined): Promise<AppConfig> {
	if (!baseURL) throw new Error("Settings fixtures require the isolated host URL");
	const wire = await E2eWire.connect(Number(new URL(baseURL).port));
	try {
		return await wire.request("settings.update", { config: ENGLISH_CONFIG });
	} finally {
		wire.close();
	}
}
