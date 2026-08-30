PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS visitors (
  visitor_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  first_country TEXT,
  first_region TEXT,
  first_city TEXT,
  last_country TEXT,
  last_region TEXT,
  last_city TEXT,
  landing_path TEXT NOT NULL,
  first_referrer_host TEXT,
  visit_count INTEGER NOT NULL DEFAULT 0,
  pageview_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  pageview_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (visitor_id) REFERENCES visitors(visitor_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pageviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  path TEXT NOT NULL,
  referrer_host TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  device_type TEXT NOT NULL,
  FOREIGN KEY (visitor_id) REFERENCES visitors(visitor_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_visitors_first_seen ON visitors(first_seen);
CREATE INDEX IF NOT EXISTS idx_visitors_last_seen ON visitors(last_seen);
CREATE INDEX IF NOT EXISTS idx_sessions_visitor ON sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
CREATE INDEX IF NOT EXISTS idx_pageviews_time ON pageviews(occurred_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_visitor_time ON pageviews(visitor_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_country_time ON pageviews(country, occurred_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_time ON rate_limits(window_started_at);
