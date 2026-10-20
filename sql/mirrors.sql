-- Progress mirrors: one row per request, events as JSONB.
-- Any Postgres-backed adapter uses this as-is.
CREATE TABLE IF NOT EXISTS request_mirrors (
    id VARCHAR(32) PRIMARY KEY,
    chat_id VARCHAR(255),
    question TEXT NOT NULL DEFAULT '',
    events JSONB NOT NULL DEFAULT '[]'::jsonb,
    answer TEXT NOT NULL DEFAULT '',
    done BOOLEAN NOT NULL DEFAULT FALSE,
    error BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW() + INTERVAL '6 hours'
);

CREATE INDEX IF NOT EXISTS idx_request_mirrors_expiry ON request_mirrors(expires_at);
