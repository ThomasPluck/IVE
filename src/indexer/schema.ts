export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  language TEXT,
  loc INTEGER NOT NULL,
  last_modified INTEGER NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  loc INTEGER NOT NULL,
  parent_symbol_id INTEGER REFERENCES symbols(id),
  FOREIGN KEY (file_id) REFERENCES files(id)
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  target_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  is_cycle INTEGER NOT NULL DEFAULT 0,
  call_line INTEGER,
  call_text TEXT NOT NULL DEFAULT '',
  UNIQUE(source_symbol_id, target_symbol_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_symbol_id);

CREATE TABLE IF NOT EXISTS git_churn (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  commit_count INTEGER NOT NULL DEFAULT 0,
  recent_commit_count INTEGER NOT NULL DEFAULT 0,
  last_author TEXT,
  last_commit_date INTEGER
);

CREATE TABLE IF NOT EXISTS metrics (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  cyclomatic_complexity INTEGER NOT NULL DEFAULT 1,
  cognitive_complexity INTEGER NOT NULL DEFAULT 0,
  parameter_count INTEGER NOT NULL DEFAULT 0,
  max_loop_depth INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  edge_id INTEGER REFERENCES edges(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL DEFAULT 'symbol',
  target_name TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  label TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'agent',
  algorithmic_complexity TEXT NOT NULL DEFAULT '',
  spatial_complexity TEXT NOT NULL DEFAULT '',
  pitfalls TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_annotations_symbol ON annotations(symbol_id);
CREATE INDEX IF NOT EXISTS idx_annotations_edge ON annotations(edge_id);
CREATE INDEX IF NOT EXISTS idx_annotations_target ON annotations(target_type, target_name);

CREATE TABLE IF NOT EXISTS test_coverage (
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  hit_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (symbol_id)
);

CREATE TABLE IF NOT EXISTS perf_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  total_files INTEGER NOT NULL,
  changed_files INTEGER NOT NULL,
  total_ms INTEGER NOT NULL,
  phases TEXT NOT NULL DEFAULT '[]',
  skipped INTEGER NOT NULL DEFAULT 0
);
`;
