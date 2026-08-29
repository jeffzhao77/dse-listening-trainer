/**
 * M3 教师端 API：班级 / 成绩看板 / 作答明细 / 错题统计 / 导出
 * 全部要求 teacher 角色。判分与题库口径复用 shared/grade.js。
 */
const express = require("express");
const { collectQuestions } = require("../shared/grade");

function createReportsRouter(db) {
  const router = express.Router();

  // ---- 权限 ----
  router.use((req, res, next) => {
    if (req.user?.role !== "teacher") {
      return res.status(403).json({ ok: false, error: "仅教师可访问" });
    }
    next();
  });

  // ---- 工具 ----
  function qmapOf(paperId) {
    const loaded = require("./db").loadPaperJson(db, paperId);
    if (!loaded) return new Map();
    const map = new Map();
    for (const q of collectQuestions(loaded.data)) {
      map.set(q.no, { no: q.no, kind: q.kind, label: q.labelText, answer: q.answer });
    }
    return map;
  }

  function parseStudentAnswer(qtype, raw) {
    if (raw == null || raw === "") return raw;
    if (qtype === "tick" || String(raw).startsWith("[")) {
      try {
        return JSON.parse(raw);
      } catch (_) {
        return raw;
      }
    }
    return String(raw);
  }

  // GET /api/classes — 班级列表（含学生数/作答数）
  router.get("/classes", (req, res) => {
    const classes = db
      .prepare(
        `SELECT c.id, c.name, c.created_at,
           (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id) AS student_count,
           (SELECT COUNT(*) FROM attempts a JOIN class_members m ON m.student_id = a.student_id
             WHERE m.class_id = c.id) AS attempt_count
         FROM classes c ORDER BY c.id`
      )
      .all();
    res.json({ ok: true, classes });
  });

  // GET /api/classes/:id/students — 班级学生列表
  router.get("/classes/:id/students", (req, res) => {
    const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(Number(req.params.id));
    if (!cls) return res.status(404).json({ ok: false, error: "班级不存在" });
    const students = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.created_at
         FROM class_members m JOIN users u ON u.id = m.student_id
         WHERE m.class_id = ? ORDER BY u.display_name`
      )
      .all(Number(req.params.id));
    res.json({ ok: true, class: cls, students });
  });

  // GET /api/reports/class/:id — 班级成绩看板
  router.get("/reports/class/:id", (req, res) => {
    const classId = Number(req.params.id);
    const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
    if (!cls) return res.status(404).json({ ok: false, error: "班级不存在" });

    const students = db
      .prepare(
        "SELECT u.id, u.username, u.display_name FROM class_members m JOIN users u ON u.id = m.student_id WHERE m.class_id = ? ORDER BY u.display_name"
      )
      .all(classId);
    const studentIds = students.map((s) => s.id);
    if (!studentIds.length) {
      return res.json({ ok: true, class: cls, paper: null, summary: null, students: [], questions: [] });
    }
    const placeholders = studentIds.map(() => "?").join(",");

    // 可选按卷过滤（?paperCode=xxx）
    let paperCond = "";
    let paperArgs = [];
    const paperCode = req.query.paperCode;
    if (paperCode) {
      const p = db.prepare("SELECT id FROM papers WHERE code = ?").get(paperCode);
      if (!p) return res.status(404).json({ ok: false, error: "试卷不存在: " + paperCode });
      paperCond = " AND a.paper_id = ?";
      paperArgs = [p.id];
    }

    // 每人最新一次 graded 作答（用于成绩与逐题正确率）
    const latest = db
      .prepare(
        `SELECT a.* FROM attempts a
         JOIN (SELECT student_id, MAX(id) mid FROM attempts a2 WHERE status = 'graded' AND student_id IN (${placeholders}) ${paperCond.replaceAll("a.", "a2.")} GROUP BY student_id) t
           ON a.id = t.mid`
      )
      .all(...studentIds, ...paperArgs);

    // 全部作答（用于总览统计与明细入口）
    const all = db
      .prepare(
        `SELECT a.*, u.display_name AS student_name, u.username
         FROM attempts a JOIN users u ON u.id = a.student_id
         WHERE a.student_id IN (${placeholders}) AND a.status = 'graded' ${paperCond}
         ORDER BY a.id`
      )
      .all(...studentIds, ...paperArgs);

    const paper = latest[0]
      ? db.prepare("SELECT id, code, year, title, total_marks FROM papers WHERE id = ?").get(latest[0].paper_id)
      : null;

    // 逐题正确率：以每人最新一次作答为样本
    let questions = [];
    if (latest.length) {
      const attemptIds = latest.map((a) => a.id);
      const ph = attemptIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT question_no, question_type, COUNT(*) AS total,
             SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
           FROM answers WHERE attempt_id IN (${ph}) GROUP BY question_no ORDER BY question_no`
        )
        .all(...attemptIds);
      const qmap = qmapOf(latest[0].paper_id);
      questions = rows.map((r) => ({
        no: r.question_no,
        kind: r.question_type,
        label: qmap.get(r.question_no)?.label || "题 #" + r.question_no,
        total: r.total,
        correct: r.correct,
        pct: r.total ? Math.round((r.correct / r.total) * 100) : 0,
      }));
    }

    const pcts = latest.map((a) => (a.question_count ? a.score / a.question_count : 0));
    const durations = latest.map((a) => a.duration_sec || 0);
    const summary = {
      students: students.length,
      attempts: all.length,
      avg_score: latest.length ? +(latest.reduce((s, a) => s + a.score, 0) / latest.length).toFixed(1) : 0,
      avg_pct: pcts.length ? Math.round((pcts.reduce((s, p) => s + p, 0) / pcts.length) * 100) : 0,
      avg_duration_sec: durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : 0,
      min_score: latest.length ? Math.min(...latest.map((a) => a.score)) : 0,
      max_score: latest.length ? Math.max(...latest.map((a) => a.score)) : 0,
    };

    const studentRows = students.map((s) => {
      const mine = all.filter((a) => a.student_id === s.id);
      const latestMine = mine[mine.length - 1] || null;
      const myPcts = mine.map((a) => (a.question_count ? a.score / a.question_count : 0));
      return {
        id: s.id,
        username: s.username,
        display_name: s.display_name,
        attempts_count: mine.length,
        avg_pct: myPcts.length ? Math.round((myPcts.reduce((x, p) => x + p, 0) / myPcts.length) * 100) : null,
        attempts: mine.map((a) => ({
          attempt_id: a.id,
          score: a.score,
          question_count: a.question_count,
          pct: a.question_count ? Math.round((a.score / a.question_count) * 100) : 0,
          submitted_at: a.submitted_at,
          duration_sec: a.duration_sec,
        })),
        latest: latestMine
          ? {
              attempt_id: latestMine.id,
              score: latestMine.score,
              correct: latestMine.correct_count,
              question_count: latestMine.question_count,
              pct: latestMine.question_count ? Math.round((latestMine.score / latestMine.question_count) * 100) : 0,
              duration_sec: latestMine.duration_sec,
              submitted_at: latestMine.submitted_at,
            }
          : null,
      };
    });

    res.json({ ok: true, class: cls, paper, summary, students: studentRows, questions });
  });

  // GET /api/reports/attempt/:id — 单次作答明细（逐题 diff）
  router.get("/reports/attempt/:id", (req, res) => {
    const attempt = db
      .prepare("SELECT * FROM attempts WHERE id = ? AND status = 'graded'")
      .get(Number(req.params.id));
    if (!attempt) return res.status(404).json({ ok: false, error: "作答不存在" });
    const student = db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(attempt.student_id);
    const paper = db
      .prepare("SELECT id, code, year, title, total_marks FROM papers WHERE id = ?")
      .get(attempt.paper_id);
    const qmap = qmapOf(attempt.paper_id);
    const answers = db
      .prepare(
        `SELECT question_no, question_type, student_answer, reference_answer, is_correct,
           points_awarded, answered_at, duration_sec, audio_plays, signal_plays, cloze_attempts
         FROM answers WHERE attempt_id = ? ORDER BY question_no`
      )
      .all(attempt.id)
      .map((r) => ({
        ...r,
        label: qmap.get(r.question_no)?.label || "题 #" + r.question_no,
        student_answer: parseStudentAnswer(r.question_type, r.student_answer),
      }));
    res.json({
      ok: true,
      attempt: {
        id: attempt.id,
        status: attempt.status,
        started_at: attempt.started_at,
        submitted_at: attempt.submitted_at,
        duration_sec: attempt.duration_sec,
        score: attempt.score,
        total_marks: attempt.total_marks,
        correct_count: attempt.correct_count,
        question_count: attempt.question_count,
      },
      student,
      paper,
      answers,
    });
  });

  // GET /api/reports/question/:no — 单题统计（错题本数据源）
  router.get("/reports/question/:no", (req, res) => {
    const qno = Number(req.params.no);
    const classId = Number(req.query.classId);
    if (!classId) return res.status(400).json({ ok: false, error: "缺少 classId" });
    const students = db
      .prepare("SELECT u.id, u.display_name FROM class_members m JOIN users u ON u.id = m.student_id WHERE m.class_id = ?")
      .all(classId);
    if (!students.length) return res.json({ ok: false, error: "班级无学生" });
    const ids = students.map((s) => s.id);
    const ph = ids.map(() => "?").join(",");
    const latest = db
      .prepare(
        `SELECT a.id, a.paper_id FROM attempts a
         JOIN (SELECT student_id, MAX(id) mid FROM attempts WHERE status = 'graded' AND student_id IN (${ph}) GROUP BY student_id) t
           ON a.id = t.mid`
      )
      .all(...ids);
    if (!latest.length) return res.json({ ok: false, error: "暂无作答" });

    const attemptIds = latest.map((a) => a.id);
    const ph2 = attemptIds.map(() => "?").join(",");
    const qmap = qmapOf(latest[0].paper_id);
    const q = qmap.get(qno);
    const rows = db
      .prepare(
        `SELECT a.id AS attempt_id, a.student_id, b.student_answer, b.reference_answer, b.is_correct, b.duration_sec, b.cloze_attempts, b.question_type
         FROM answers b JOIN attempts a ON a.id = b.attempt_id
         WHERE b.question_no = ? AND b.attempt_id IN (${ph2})`
      )
      .all(qno, ...attemptIds);
    const total = rows.length;
    const correct = rows.filter((r) => r.is_correct === 1).length;
    const wrong = rows
      .filter((r) => r.is_correct !== 1)
      .map((r) => {
        const stu = students.find((s) => s.id === r.student_id);
        return {
          attempt_id: r.attempt_id,
          student_name: stu?.display_name || "未知",
          student_answer: parseStudentAnswer(r.question_type, r.student_answer),
          duration_sec: r.duration_sec,
          cloze_attempts: r.cloze_attempts,
        };
      });
    res.json({
      ok: true,
      question: { no: qno, kind: q?.kind || null, label: q?.label || "题 #" + qno, reference_answer: q?.answer || null },
      stats: { total, correct, pct: total ? Math.round((correct / total) * 100) : 0 },
      wrong,
    });
  });

  return router;
}

module.exports = { createReportsRouter };
