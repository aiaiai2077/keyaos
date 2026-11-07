import type { DbModelSyncJob } from "./schema";

export class ModelSyncJobsDao {
	constructor(private db: D1Database) {}

	async create(params: {
		ownerId: string;
		credentialId: string;
		providerId: string;
	}): Promise<DbModelSyncJob> {
		const id = `model_sync_${crypto.randomUUID()}`;
		const now = Date.now();
		await this.db
			.prepare(
				`INSERT INTO model_sync_jobs (
					id, owner_id, credential_id, provider_id, status,
					model_count, created_at, updated_at
				) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`,
			)
			.bind(
				id,
				params.ownerId,
				params.credentialId,
				params.providerId,
				now,
				now,
			)
			.run();

		const job = await this.getForOwner(id, params.ownerId);
		if (!job)
			throw new Error("Failed to retrieve newly created model sync job");
		return job;
	}

	async getForOwner(
		id: string,
		ownerId: string,
	): Promise<DbModelSyncJob | null> {
		return this.db
			.prepare("SELECT * FROM model_sync_jobs WHERE id = ? AND owner_id = ?")
			.bind(id, ownerId)
			.first<DbModelSyncJob>();
	}

	async markRunning(id: string): Promise<void> {
		await this.db
			.prepare(
				"UPDATE model_sync_jobs SET status = 'running', updated_at = ? WHERE id = ?",
			)
			.bind(Date.now(), id)
			.run();
	}

	async markCompleted(id: string, modelCount: number): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				`UPDATE model_sync_jobs
				 SET status = 'completed', model_count = ?, error = NULL,
				     updated_at = ?, completed_at = ?
				 WHERE id = ?`,
			)
			.bind(modelCount, now, now, id)
			.run();
	}

	async markFailed(id: string, error: string): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				`UPDATE model_sync_jobs
				 SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
				 WHERE id = ?`,
			)
			.bind(error, now, now, id)
			.run();
	}
}
