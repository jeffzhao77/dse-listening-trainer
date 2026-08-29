PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  teacher_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS class_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, student_id)
);

CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  year INTEGER,
  paper_part TEXT NOT NULL DEFAULT 'A',
  title TEXT NOT NULL,
  total_marks INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  audio_base_path TEXT,
  content_json_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES papers(id),
  question_no INTEGER NOT NULL,
  type TEXT,
  kind TEXT,
  points INTEGER NOT NULL DEFAULT 1,
  reference_answer_json TEXT,
  ts_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (paper_id, question_no)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id),
  paper_id INTEGER NOT NULL REFERENCES papers(id),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'submitted', 'graded')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  duration_sec INTEGER,
  score INTEGER,
  total_marks INTEGER,
  correct_count INTEGER,
  question_count INTEGER,
  answers_snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attempts_student_paper ON attempts(student_id, paper_id, status);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  question_no INTEGER NOT NULL,
  question_type TEXT,
  student_answer TEXT,
  reference_answer TEXT,
  is_correct INTEGER,
  points_awarded INTEGER,
  points_total INTEGER DEFAULT 1,
  answered_at TEXT,
  duration_sec INTEGER,
  audio_plays INTEGER DEFAULT 0,
  signal_plays INTEGER DEFAULT 0,
  cloze_attempts INTEGER DEFAULT 0,
  UNIQUE (attempt_id, question_no)
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  attempt_id INTEGER REFERENCES attempts(id),
  question_no INTEGER,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS answer_ai_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL REFERENCES answers(id),
  analysis_type TEXT,
  analysis_text TEXT,
  confidence REAL,
  model_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
