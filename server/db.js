const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { collectQuestions } = require("../shared/grade");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "dse.sqlite");
const SCHEMA = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
const MT56_JSON = path.join(ROOT, "MT56-PartA-学生完整包", "data", "mt56_partA.json");

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(password, s, 32).toString("hex");
  return `${s}:${h}`;
}

function verifyPassword(password, stored) {
  const [salt, h] = String(stored).split(":");
  if (!salt || !h) return false;
  const check = crypto.scryptSync(password, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(check, "hex"));
}

function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const n = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (n > 0) return;

  const insUser = db.prepare(
    "INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)"
  );
  const teacher = insUser.run("teacher", hashPassword("teacher123"), "teacher", "测试教师");
  const student = insUser.run("student", hashPassword("student123"), "student", "测试学生");

  const cls = db
    .prepare("INSERT INTO classes (name, teacher_id) VALUES (?, ?)")
    .run("默认班级", teacher.lastInsertRowid);
  db.prepare("INSERT INTO class_members (class_id, student_id) VALUES (?, ?)").run(
    cls.lastInsertRowid,
    student.lastInsertRowid
  );

  const paperJson = JSON.parse(fs.readFileSync(MT56_JSON, "utf8"));
  const relPath = "MT56-PartA-学生完整包/data/mt56_partA.json";
  const paper = db
    .prepare(
      `INSERT INTO papers (code, year, paper_part, title, total_marks, version, audio_base_path, content_json_path, status, created_by)
       VALUES (?, ?, 'A', ?, ?, 1, ?, ?, 'published', ?)`
    )
    .run(
      paperJson.id || "mt56",
      paperJson.year || null,
      paperJson.title || "MT56 Part A",
      paperJson.totalMarks || 42,
      "/papers/mt56/",
      relPath,
      teacher.lastInsertRowid
    );

  const insQ = db.prepare(
    `INSERT INTO questions (paper_id, question_no, type, kind, points, reference_answer_json, ts_json)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  );
  for (const q of collectQuestions(paperJson)) {
    insQ.run(
      paper.lastInsertRowid,
      q.no,
      q.type || q.kind || null,
      q.kind || null,
      JSON.stringify(q.answer ?? null),
      JSON.stringify(q.ts || null)
    );
  }
}

function loadPaperJson(db, paperId) {
  const paper = db.prepare("SELECT * FROM papers WHERE id = ?").get(paperId);
  if (!paper) return null;
  const abs = path.join(ROOT, paper.content_json_path);
  return { paper, data: JSON.parse(fs.readFileSync(abs, "utf8")) };
}

module.exports = { openDb, hashPassword, verifyPassword, loadPaperJson, DB_PATH };
