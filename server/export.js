/**
 * M3 教师端导出 API：CSV（Excel 兼容，UTF-8 BOM）+ 结构化 JSON
 * GET /api/export/students.csv  ?classId=  成绩单
 * GET /api/export/answers.csv   ?classId=  逐题明细
 * GET /api/export/answers.json  ?classId=  结构化 JSON（含题目 ts 音频时间戳）
 */
const express = require("express");
const { collectQuestions } = require("../shared/grade");

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(rows) {
  return "\uFEFF" + rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

function createExportRouter(db) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (req.user?.role !== "teacher") {
      return res.status(403).json({ ok: false, error: "仅教师可访问" });
    }
    next();
  });

  function qmapOf(paperId) {
    const loaded = require("./db").loadPaperJson(db, paperId);
    if (!loaded) return new Map();
    const map = new Map();
    for (const q of collectQuestions(loaded.data)) {
      map.set(q.no, { no: q.no, kind: q.kind, label: q.labelText, answer: q.answer, ts: q.ts || null });
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

  // 可选的班级过滤 → 学生 id 集合
  function scope(classId) {
    if (!classId) return null;
    const rows = db
      .prepare("SELECT student_id FROM class_members WHERE class_id = ?")
      .all(Number(classId));
    return rows.map((r) => r.student_id);
  }
  function whereClause(ids, prefix) {
    if (!ids || !ids.length) return { sql: "", params: [] };
    return { sql: ` AND ${prefix} IN (${ids.map(() => "?").join(",")})`, params: ids };
  }

  // GET /api/export/students.csv
  router.get("/students.csv", (req, res) => {
    const ids = scope(req.query.classId);
    const { sql, params } = whereClause(ids, "a.student_id");
    const rows = db
      .prepare(
        `SELECT u.display_name AS student_name, u.username, c.name AS class_name,
           p.code AS paper_code, p.title AS paper_title, a.score, a.question_count,
           a.duration_sec, a.submitted_at, a.id AS attempt_id
         FROM attempts a
         JOIN users u ON u.id = a.student_id
         JOIN papers p ON p.id = a.paper_id
         LEFT JOIN class_members m ON m.student_id = a.student_id
         LEFT JOIN classes c ON c.id = m.class_id
         WHERE a.status = 'graded'${sql}
         ORDER BY a.submitted_at`
      )
      .all(...params);
    const header = ["学生姓名", "用户名", "班级", "试卷代码", "试卷标题", "得分", "总题数", "整卷耗时(秒)", "提交时间", "作答ID"];
    const body = rows.map((r) => [
      r.student_name,
      r.username,
      r.class_name || "",
      r.paper_code,
      r.paper_title,
      r.score,
      r.question_count,
      r.duration_sec,
      r.submitted_at,
      r.attempt_id,
    ]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="students_${Date.now()}.csv"`);
    res.send(toCsv([header, ...body]));
  });

  // GET /api/export/answers.csv
  router.get("/answers.csv", (req, res) => {
    const ids = scope(req.query.classId);
    const { sql, params } = whereClause(ids, "a.student_id");
    const rows = db
      .prepare(
        `SELECT u.display_name AS student_name, u.username, p.code AS paper_code, p.title AS paper_title,
           b.question_no, b.question_type, b.student_answer, b.reference_answer, b.is_correct,
           b.points_awarded, b.answered_at, b.duration_sec, b.audio_plays, b.signal_plays, b.cloze_attempts,
           a.id AS attempt_id, a.paper_id
         FROM answers b
         JOIN attempts a ON a.id = b.attempt_id
         JOIN users u ON u.id = a.student_id
         JOIN papers p ON p.id = a.paper_id
         WHERE a.status = 'graded'${sql}
         ORDER BY a.id, b.question_no`
      )
      .all(...params);
    const header = ["学生姓名", "用户名", "试卷代码", "试卷标题", "题号", "题型", "学生答案", "标准答案", "对错", "得分", "作答时间", "该题耗时(秒)", "整段播放次数", "信号句播放次数", "精听尝试次数", "作答ID"];
    const body = rows.map((r) => {
      const qmap = qmapOf(r.paper_id);
      const label = qmap.get(r.question_no)?.label || "";
      const sa = parseStudentAnswer(r.question_type, r.student_answer);
      return [
        r.student_name,
        r.username,
        r.paper_code,
        r.paper_title,
        r.question_no,
        r.question_type,
        label,
        Array.isArray(sa) ? sa.join(", ") : sa,
        r.reference_answer,
        r.is_correct === 1 ? "对" : "错",
        r.points_awarded,
        r.answered_at,
        r.duration_sec,
        r.audio_plays,
        r.signal_plays,
        r.cloze_attempts,
        r.attempt_id,
      ];
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="answers_${Date.now()}.csv"`);
    res.send(toCsv([header, ...body]));
  });

  // GET /api/export/answers.json — 结构化 JSON（AI 数据源，含 ts 音频时间戳）
  router.get("/answers.json", (req, res) => {
    const ids = scope(req.query.classId);
    const { sql, params } = whereClause(ids, "a.student_id");
    const rows = db
      .prepare(
        `SELECT u.display_name AS student_name, u.username, p.code AS paper_code, p.title AS paper_title,
           p.id AS paper_id, a.id AS attempt_id, a.started_at, a.submitted_at, a.duration_sec AS attempt_duration_sec,
           a.score, a.question_count,
           b.question_no, b.question_type, b.student_answer, b.reference_answer, b.is_correct,
           b.points_awarded, b.answered_at, b.duration_sec AS question_duration_sec,
           b.audio_plays, b.signal_plays, b.cloze_attempts
         FROM answers b
         JOIN attempts a ON a.id = b.attempt_id
         JOIN users u ON u.id = a.student_id
         JOIN papers p ON p.id = a.paper_id
         WHERE a.status = 'graded'${sql}
         ORDER BY a.id, b.question_no`
      )
      .all(...params);

    const qcache = new Map();
    const answers = rows.map((r) => {
      if (!qcache.has(r.paper_id)) qcache.set(r.paper_id, qmapOf(r.paper_id));
      const qmap = qcache.get(r.paper_id);
      const q = qmap.get(r.question_no) || {};
      return {
        student: { name: r.student_name, username: r.username },
        attempt: {
          id: r.attempt_id,
          started_at: r.started_at,
          submitted_at: r.submitted_at,
          duration_sec: r.attempt_duration_sec,
          score: r.score,
          question_count: r.question_count,
        },
        paper: { code: r.paper_code, title: r.paper_title },
        question: {
          no: r.question_no,
          kind: r.question_type,
          label: q.label || null,
          ts: q.ts || null,
        },
        student_answer: parseStudentAnswer(r.question_type, r.student_answer),
        reference_answer: r.reference_answer,
        is_correct: r.is_correct === 1,
        points_awarded: r.points_awarded,
        answered_at: r.answered_at,
        question_duration_sec: r.question_duration_sec,
        audio_plays: r.audio_plays,
        signal_plays: r.signal_plays,
        cloze_attempts: r.cloze_attempts,
      };
    });
    res.json({
      exported_at: new Date().toISOString(),
      format: "dse-listening-answers-v1",
      answer_count: answers.length,
      answers,
    });
  });

  return router;
}

module.exports = { createExportRouter };
