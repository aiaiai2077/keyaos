CREATE TABLE IF NOT EXISTS model_sync_jobs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    model_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_model_sync_jobs_owner_created
    ON model_sync_jobs(owner_id, created_at DESC);
