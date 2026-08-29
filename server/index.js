const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { openDb, verifyPassword, loadPaperJson } = require("./db");
const { collectQuestions, gradeQuestion, studentAnswerPayload } = require("../shared/grade");
const { createReportsRouter } = require("./reports");
const { createExportRouter } = require("./export");
const { createToolsRouter } = require("./tools");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 3000;
const MT56_DIR = path.join(ROOT, "MT56-PartA-学生完整包");

const db = openDb();
const sessions = new Map();

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).dse_session;
  if (!token) return null;
  return sessions.get(token) || null;
}

function requireLogin(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ ok: false, error: "未登录" });
    }
    return res.redirect("/");
  }
  req.user = user;
  next();
}

function requireStudent(req, res, next) {
  if (req.user.role !== "student") {
    return res.status(403).json({ ok: false, error: "仅学生可作答" });
  }
  next();
}

function publicUser(row) {
  return { id: row.id, username: row.username, role: row.role, displayName: row.display_name };
}

function addEvent(userId, attemptId, eventType, payload) {
  db.prepare(
    "INSERT INTO analytics_events (user_id, attempt_id, question_no, event_type, payload_json) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, attemptId, payload?.question_no ?? null, eventType, JSON.stringify(payload || {}));
}

function snapshotFromBody(body) {
  return JSON.stringify({
    A: body.A || {},
    T: body.T || {},
    STUDY_TASK: body.STUDY_TASK || 1,
  });
}

function runTx(fn) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (_) {}
    throw err;
  }
}

function upsertDraftAnswers(attemptId, DATA, A, T) {
  const qlist = collectQuestions(DATA);
  const upsert = db.prepare(
    `INSERT INTO answers (attempt_id, question_no, question_type, student_answer, answered_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(attempt_id, question_no) DO UPDATE SET
       student_answer = excluded.student_answer,
       question_type = excluded.question_type,
       answered_at = excluded.answered_at`
  );
  runTx(() => {
    for (const q of qlist) {
      upsert.run(attemptId, q.no, q.kind, studentAnswerPayload(q, A, T));
    }
  });
}

function getAttemptForStudent(id, studentId) {
  return db.prepare("SELECT * FROM attempts WHERE id = ? AND student_id = ?").get(id, studentId);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ ok: false, error: "账号或密码不正确" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  const session = publicUser(row);
  sessions.set(token, session);
  res.setHeader("Set-Cookie", `dse_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true, user: session });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req).dse_session;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "dse_session=; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ ok: false });
  res.json({ ok: true, user });
});

app.post("/api/attempts", requireLogin, requireStudent, (req, res) => {
  const code = String(req.body?.paperCode || "mt56");
  const paper = db.prepare("SELECT * FROM papers WHERE code = ? AND status = 'published'").get(code);
  if (!paper) return res.status(404).json({ ok: false, error: "试卷不存在" });

  let attempt = db
    .prepare(
      "SELECT * FROM attempts WHERE student_id = ? AND paper_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1"
    )
    .get(req.user.id, paper.id);

  if (!attempt) {
    const r = db
      .prepare(
        "INSERT INTO attempts (student_id, paper_id, status, total_marks, question_count) VALUES (?, ?, 'in_progress', ?, ?)"
      )
      .run(req.user.id, paper.id, paper.total_marks, null);
    attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(r.lastInsertRowid);
    addEvent(req.user.id, attempt.id, "attempt_started", { paperCode: code });
  }

  res.json({ ok: true, attempt });
});

app.get("/api/attempts/:id", requireLogin, requireStudent, (req, res) => {
  const attempt = getAttemptForStudent(Number(req.params.id), req.user.id);
  if (!attempt) return res.status(404).json({ ok: false, error: "作答不存在" });
  const answers = db.prepare("SELECT * FROM answers WHERE attempt_id = ? ORDER BY question_no").all(attempt.id);
  res.json({ ok: true, attempt, answers });
});

app.post("/api/attempts/:id/answers", requireLogin, requireStudent, (req, res) => {
  const attempt = getAttemptForStudent(Number(req.params.id), req.user.id);
  if (!attempt) return res.status(404).json({ ok: false, error: "作答不存在" });
  if (attempt.status !== "in_progress") {
    return res.status(409).json({ ok: false, error: "该卷已提交，不能再改" });
  }
  const loaded = loadPaperJson(db, attempt.paper_id);
  const snap = snapshotFromBody(req.body);
  db.prepare("UPDATE attempts SET answers_snapshot_json = ? WHERE id = ?").run(snap, attempt.id);
  upsertDraftAnswers(attempt.id, loaded.data, req.body.A || {}, req.body.T || {});
  addEvent(req.user.id, attempt.id, "answers_saved", {});
  res.json({ ok: true });
});

app.post("/api/attempts/:id/submit", requireLogin, requireStudent, (req, res) => {
  const attempt = getAttemptForStudent(Number(req.params.id), req.user.id);
  if (!attempt) return res.status(404).json({ ok: false, error: "作答不存在" });
  if (attempt.status !== "in_progress") {
    const answers = db.prepare("SELECT * FROM answers WHERE attempt_id = ? ORDER BY question_no").all(attempt.id);
    return res.json({ ok: true, attempt, answers, alreadySubmitted: true });
  }

  const loaded = loadPaperJson(db, attempt.paper_id);
  const A = req.body.A || {};
  const T = req.body.T || {};
  const snap = snapshotFromBody(req.body);
  const qlist = collectQuestions(loaded.data);
  const started = new Date(attempt.started_at.replace(" ", "T") + "Z");
  const durationSec = Math.max(0, Math.round((Date.now() - started.getTime()) / 1000));

  const upsert = db.prepare(
    `INSERT INTO answers (attempt_id, question_no, question_type, student_answer, reference_answer, is_correct, points_awarded, points_total, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(attempt_id, question_no) DO UPDATE SET
       student_answer = excluded.student_answer,
       reference_answer = excluded.reference_answer,
       is_correct = excluded.is_correct,
       points_awarded = excluded.points_awarded,
       question_type = excluded.question_type,
       answered_at = excluded.answered_at`
  );

  let correct = 0;
  runTx(() => {
    for (const q of qlist) {
      const g = gradeQuestion(q, A, T);
      if (g.ok) correct += 1;
      upsert.run(
        attempt.id,
        q.no,
        q.kind,
        studentAnswerPayload(q, A, T),
        String(g.key ?? ""),
        g.ok ? 1 : 0,
        g.ok ? 1 : 0
      );
    }
    db.prepare(
      `UPDATE attempts SET
         status = 'graded',
         submitted_at = datetime('now'),
         duration_sec = ?,
         score = ?,
         total_marks = ?,
         correct_count = ?,
         question_count = ?,
         answers_snapshot_json = ?
       WHERE id = ?`
    ).run(durationSec, correct, qlist.length, correct, qlist.length, snap, attempt.id);
  });

  addEvent(req.user.id, attempt.id, "attempt_submitted", { score: correct, total: qlist.length });
  const saved = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attempt.id);
  const answers = db.prepare("SELECT * FROM answers WHERE attempt_id = ? ORDER BY question_no").all(attempt.id);
  res.json({ ok: true, attempt: saved, answers });
});

app.get("/", (req, res) => {
  const user = currentUser(req);
  if (user) {
    return res.redirect(user.role === "teacher" ? "/teacher" : "/exam");
  }
  res.sendFile(path.join(ROOT, "apps", "student", "login.html"));
});

app.get("/exam", requireLogin, (req, res) => {
  if (req.user.role === "teacher") return res.redirect("/teacher");
  res.sendFile(path.join(ROOT, "apps", "student", "exam.html"));
});

app.get("/teacher", requireLogin, (req, res) => {
  if (req.user.role !== "teacher") return res.redirect("/exam");
  res.sendFile(path.join(ROOT, "apps", "teacher", "dashboard.html"));
});

app.get("/tools", requireLogin, (req, res) => {
  if (req.user.role !== "teacher") return res.redirect("/exam");
  res.sendFile(path.join(ROOT, "apps", "teacher", "tools.html"));
});

app.use("/api", requireLogin, createReportsRouter(db));
app.use("/api", requireLogin, createToolsRouter());
app.use("/api/export", requireLogin, createExportRouter(db));

app.use("/papers/mt56", requireLogin, express.static(MT56_DIR));
app.use("/papers/2021HKDSE", requireLogin, express.static(path.join(ROOT, "2021HKDSE-新卷"))); // 2021 卷独立目录

app.listen(PORT, () => {
  console.log(`DSE Listening System M3 已启动: http://localhost:${PORT}`);
  console.log("学生账号 student / student123 | 教师账号 teacher / teacher123");
  console.log("演示数据: node scripts/seed-demo.js");
});
