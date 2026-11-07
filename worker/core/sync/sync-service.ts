/**
 * Model & Credential Sync Service
 *
 * Three-phase OpenRouter-first sync:
 * Phase 1 — Sync OpenRouter chat models (canonical catalog, authoritative `created`).
 * Phase 2 — Sync OpenRouter embedding models (separate endpoint).
 * Phase 3 — Sync remaining providers in parallel, filtered to OpenRouter allowlist.
 *           Inherits canonical `created` so all providers share the model's true creation time.
 */

import { log } from "../../shared/logger";
import type { Env } from "../../shared/types";
import { CatalogDao } from "../db/catalog-dao";
import { CredentialsDao } from "../db/credentials-dao";
import type { ParsedModel } from "../providers/interface";
import {
	getAllProviders,
	getProvider,
	parseOpenRouterModels,
} from "../providers/registry";

const OPENROUTER_EMBEDDINGS_URL =
	"https://openrouter.ai/api/v1/embeddings/models";
const OPENROUTER_IMAGE_MODELS_URL =
	"https://openrouter.ai/api/v1/models?output_modality=image";

export async function syncAllModels(
	db: D1Database,
	cnyUsdRate = 7,
	env?: Env,
): Promise<number> {
	const dao = new CatalogDao(db);
	const allProviders = getAllProviders();
	const credentialsDao = env?.ENCRYPTION_KEY
		? new CredentialsDao(db, env.ENCRYPTION_KEY)
		: null;
	const credentials = credentialsDao
		? (await credentialsDao.getGlobal()).filter(
				(credential) => credential.is_enabled === 1,
			)
		: [];

	const fetchProviderModels = async (
		provider: (typeof allProviders)[number],
	): Promise<ParsedModel[]> => {
		const systemKey =
			provider.systemKeyEnvVar && env
				? (env as unknown as Record<string, string | undefined>)[
						provider.systemKeyEnvVar
					]
				: undefined;
		const providerCredentials = credentials
			.filter((credential) => credential.provider_id === provider.info.id)
			.sort((a, b) => {
				const healthOrder: Record<string, number> = {
					ok: 0,
					degraded: 1,
					cooldown: 2,
					dead: 3,
				};
				return (
					(healthOrder[a.health_status] ?? 4) -
					(healthOrder[b.health_status] ?? 4)
				);
			});

		let credentialAttempts = 0;
		for (const credential of providerCredentials) {
			try {
				const secret = await credentialsDao?.decryptSecret(credential);
				if (!secret) continue;
				credentialAttempts++;
				const models = await provider.fetchModels(cnyUsdRate, secret);
				if (models.length > 0) {
					log.info("sync", "Models fetched using stored credential", {
						provider_id: provider.info.id,
						models: models.length,
						credential_attempts: credentialAttempts,
					});
					return models;
				}
			} catch (error) {
				log.warn("sync", "Stored-credential model fetch failed", {
					provider_id: provider.info.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (credentialAttempts > 0) {
			log.warn("sync", "No models returned by stored credentials", {
				provider_id: provider.info.id,
				credential_attempts: credentialAttempts,
			});
		}

		if (systemKey) {
			try {
				const models = await provider.fetchModels(cnyUsdRate, systemKey);
				if (models.length > 0) return models;
			} catch (error) {
				log.warn("sync", "System-key model fetch failed", {
					provider_id: provider.info.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		try {
			const models = await provider.fetchModels(cnyUsdRate);
			if (models.length > 0) return models;
		} catch (error) {
			log.warn("sync", "Public model fetch failed", {
				provider_id: provider.info.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return [];
	};

	// ─── Phase 1: Sync OpenRouter chat models (canonical catalog) ───
	const orProvider = allProviders.find((p) => p.info.id === "openrouter");
	if (!orProvider) {
		throw new Error("OpenRouter provider not found in registry");
	}

	const orModels = await fetchProviderModels(orProvider);
	if (orModels.length === 0) {
		throw new Error(
			"OpenRouter returned no models; the existing catalog was left unchanged",
		);
	}

	await dao.upsert(orModels);
	log.info("sync", "OpenRouter chat synced", { count: orModels.length });

	// ─── Phase 2: Sync OpenRouter embedding models ──────────────
	let orEmbedModels: typeof orModels = [];
	try {
		const res = await fetch(OPENROUTER_EMBEDDINGS_URL);
		if (res.ok) {
			const raw = (await res.json()) as Record<string, unknown>;
			orEmbedModels = parseOpenRouterModels(raw, "embedding");
			if (orEmbedModels.length > 0) {
				await dao.upsert(orEmbedModels);
			}
			log.info("sync", "OpenRouter embeddings synced", {
				count: orEmbedModels.length,
			});
		}
	} catch (err) {
		log.error("sync", "Embedding sync failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// ─── Phase 2b: Sync OpenRouter image-only models ─────────
	// Image-only models (Flux, Sourceful, etc.) are excluded from the default
	// /models endpoint and require the ?output_modality=image query parameter.
	let orImageModels: typeof orModels = [];
	try {
		const res = await fetch(OPENROUTER_IMAGE_MODELS_URL);
		if (res.ok) {
			const raw = (await res.json()) as Record<string, unknown>;
			const allImageModels = parseOpenRouterModels(raw);
			const existingIds = new Set(orModels.map((m) => m.model_id));
			orImageModels = allImageModels.filter(
				(m) => !existingIds.has(m.model_id),
			);
			if (orImageModels.length > 0) {
				await dao.upsert(orImageModels);
			}
			log.info("sync", "OpenRouter image-only models synced", {
				count: orImageModels.length,
			});
		}
	} catch (err) {
		log.error("sync", "Image model sync failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Deactivate missing OpenRouter models (chat + embedding + image combined)
	const allOrIds = [
		...orModels.map((m) => m.id),
		...orEmbedModels.map((m) => m.id),
		...orImageModels.map((m) => m.id),
	];
	await dao.deactivateMissing("openrouter", allOrIds);

	// Build canonical lookup: model_id → OpenRouter pricing/metadata
	const allOrModels = [...orModels, ...orEmbedModels, ...orImageModels];
	const allowedModelIds = new Set(allOrModels.map((m) => m.model_id));
	const canonicalMap = new Map(allOrModels.map((m) => [m.model_id, m]));

	// ─── Phase 3: Sync other providers, filtering to allowlist ──
	const otherProviders = allProviders.filter((p) => p.info.id !== "openrouter");
	let syncedProviderModels = 0;
	const results = await Promise.allSettled(
		otherProviders.map(async (provider) => {
			const models = await fetchProviderModels(provider);
			if (models.length === 0) {
				log.warn("sync", "0 models, skipping", {
					provider_id: provider.info.id,
				});
				return 0;
			}

			const filtered = models.filter((m) => allowedModelIds.has(m.model_id));
			if (filtered.length === 0) {
				log.warn("sync", "0 models after OpenRouter filter, skipping", {
					provider_id: provider.info.id,
					total: models.length,
				});
				return 0;
			}

			for (const m of filtered) {
				const canonical = canonicalMap.get(m.model_id);
				if (!canonical) continue;

				m.created = canonical.created;

				if (m.input_price < 0) {
					m.input_price = canonical.input_price;
					m.output_price = canonical.output_price;
					m.model_type = canonical.model_type;
					m.name ??= canonical.name;
					m.context_length ??= canonical.context_length;
					m.input_modalities ??= canonical.input_modalities;
					m.output_modalities ??= canonical.output_modalities;
				}
			}

			await dao.upsert(filtered);
			await dao.deactivateMissing(
				provider.info.id,
				filtered.map((m) => m.id),
			);
			log.info("sync", "Models synced", {
				provider_id: provider.info.id,
				total: models.length,
				kept: filtered.length,
				filtered: models.length - filtered.length,
			});
			return filtered.length;
		}),
	);

	for (const r of results) {
		if (r.status === "fulfilled") {
			syncedProviderModels += r.value;
		} else {
			log.error("sync", "Provider failed", {
				error: r.reason instanceof Error ? r.reason.message : String(r.reason),
			});
		}
	}
	const syncedModels = allOrModels.length + syncedProviderModels;
	log.info("sync", "Local model catalog sync completed", { syncedModels });
	return syncedModels;
}

const CATALOG_URL = "https://keyaos.com/api/catalog";

/**
 * Remote Catalog Sync — fetch the full model catalog from keyaos.com
 * and replicate it into the local DB.
 * On any failure, the local DB is left unchanged.
 */
export async function syncFromRemote(db: D1Database): Promise<number> {
	let res: Response;
	try {
		const catalogUrl = new URL(CATALOG_URL);
		catalogUrl.searchParams.set("_sync", Date.now().toString());
		res = await fetch(catalogUrl, {
			headers: { "x-keyaos-cache-bypass": "1" },
		});
	} catch (err) {
		log.error("sync", "Catalog fetch error", {
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}

	if (!res.ok) {
		throw new Error(`Catalog fetch failed with status ${res.status}`);
	}

	const body = (await res.json()) as { data?: ParsedModel[] };
	const entries = body.data;
	if (!Array.isArray(entries) || entries.length === 0) {
		throw new Error("Catalog returned no model entries");
	}

	const dao = new CatalogDao(db);
	await dao.upsert(entries);

	const byProvider = new Map<string, string[]>();
	for (const e of entries) {
		let ids = byProvider.get(e.provider_id);
		if (!ids) {
			ids = [];
			byProvider.set(e.provider_id, ids);
		}
		ids.push(e.id);
	}

	for (const [providerId, ids] of byProvider) {
		await dao.deactivateMissing(providerId, ids);
	}

	log.info("sync", "Remote catalog synced", {
		entries: entries.length,
		providers: byProvider.size,
	});
	return entries.length;
}

export async function syncModels(
	db: D1Database,
	cnyUsdRate = 7,
	env?: Env,
): Promise<number> {
	if (env?.LOCAL_SYNC) return syncAllModels(db, cnyUsdRate, env);

	try {
		return await syncAllModels(db, cnyUsdRate, env);
	} catch (error) {
		log.warn("sync", "Provider API sync failed; trying remote catalog", {
			error: error instanceof Error ? error.message : String(error),
		});
		return syncFromRemote(db);
	}
}

export async function syncAutoCredits(
	db: D1Database,
	encryptionKey: string,
	cnyUsdRate = 7,
): Promise<void> {
	const dao = new CredentialsDao(db, encryptionKey);
	const autos = (await dao.getGlobal()).filter(
		(c) => c.quota_source === "auto",
	);

	const results = await Promise.allSettled(
		autos.map(async (credential) => {
			const provider = getProvider(credential.provider_id);
			if (!provider) return;

			const secret = await dao.decryptSecret(credential);
			const credits = await provider.fetchCredits(secret);
			if (credits?.remaining == null) return;

			const usd =
				provider.info.currency === "CNY"
					? credits.remaining / cnyUsdRate
					: credits.remaining;

			await dao.updateQuota(credential.id, usd, "auto");
		}),
	);

	for (const r of results) {
		if (r.status === "rejected") {
			log.error("sync", "Credential sync failed", {
				error: r.reason instanceof Error ? r.reason.message : String(r.reason),
			});
		}
	}
}

export interface CredentialHealthCheckResult {
	total: number;
	healthy: number;
	degraded: number;
	skipped: number;
	failed: number;
}

export async function syncCredentialHealth(
	db: D1Database,
	encryptionKey: string,
	ownerId?: string,
): Promise<CredentialHealthCheckResult> {
	const dao = new CredentialsDao(db, encryptionKey);
	const credentials = ownerId
		? await dao.getAll(ownerId)
		: await dao.getGlobal();
	const result: CredentialHealthCheckResult = {
		total: credentials.length,
		healthy: 0,
		degraded: 0,
		skipped: 0,
		failed: 0,
	};

	for (let i = 0; i < credentials.length; i += 16) {
		const batch = credentials.slice(i, i + 16);
		const results = await Promise.allSettled(
			batch.map(async (credential) => {
				const provider = getProvider(credential.provider_id);
				if (!provider) {
					result.skipped += 1;
					log.warn(
						"sync",
						"Credential health check skipped: unknown provider",
						{
							providerId: credential.provider_id,
						},
					);
					return;
				}

				try {
					const secret = await dao.decryptSecret(credential);
					const isValid = await provider.validateKey(secret);
					const status = isValid ? "ok" : "degraded";
					await dao.reportHealthCheck(credential.id, status, ownerId);
					return status;
				} catch (error) {
					log.error("sync", "Credential health check failed", {
						providerId: credential.provider_id,
						error: error instanceof Error ? error.message : String(error),
					});
					await dao.reportHealthCheck(credential.id, "degraded", ownerId);
					return "degraded";
				}
			}),
		);
		for (const settled of results) {
			if (settled.status === "fulfilled") {
				if (settled.value === "ok") result.healthy += 1;
				else if (settled.value === "degraded") result.degraded += 1;
			} else {
				result.failed += 1;
				log.error("sync", "Failed to persist credential health status", {
					error:
						settled.reason instanceof Error
							? settled.reason.message
							: String(settled.reason),
				});
			}
		}
	}

	log.info("sync", "Daily credential health check completed", {
		...result,
	});
	return result;
}
