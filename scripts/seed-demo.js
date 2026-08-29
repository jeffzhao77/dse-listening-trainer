/**
 * 演示数据生成脚本（M3 教师端验证用，扩展支持多卷）
 *
 * 生成多个学生、每人多次作答，用 shared/grade.js 判分引擎落库，
 * 保证演示数据与服务器权威判分口径一致。
 *
 * 幂等：demo_ 前缀学生已存在时跳过该卷（每卷独立检测，可补跑未注入的卷）。
 * 支持卷：mt56（demo 包）、2021HKDSE（2021 真题，路径自动探测）。
 *
 * 用法: node scripts/seed-demo.js [--paper=mt56|2021HKDSE]（省略则两卷都生成）
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { collectQuestions, gradeQuestion } = require("../shared/grade");

const ROOT = path.join(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "dse.sqlite");

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(password, s, 32).toString("hex");
  return `${s}:${h}`;
}

// ---- 随机答案生成 ----
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function chance(p) {
  return Math.random() < p;
}
function randomFill(q) {
  if (chance(0.55)) {
    const key = String(q.answer[0] || "").replace(/\([^)]*\)/g, "").split("/")[0].trim();
    return key || "something";
  }
  const wrongs = ["banana", "bread", "sugar", "bun", "milk", "flour", "butter", "egg", "oven", "shop"];
  return pick(wrongs);
}
function randomNum(q) {
  return chance(0.7) ? String(q.answer) : String(Number(q.answer) + pick([1, 2, -1]));
}
function randomLetter(q) {
  if (chance(0.65)) return String(q.answer);
  const letters = "ABCDEF".split("").filter((x) => x !== String(q.answer));
  return pick(letters);
}
function randomTick(q) {
  const ans = q.answer || [];
  if (chance(0.6)) return [...ans];
  const pool = [...ans, "X", "Y"].filter((v, i, a) => a.indexOf(v) === i);
  const n = Math.floor(Math.random() * pool.length);
  return pool.slice(0, n);
}
function randomAnswerFor(q) {
  switch (q.kind) {
    case "fill":
      return randomFill(q);
    case "num":
      return randomNum(q);
    case "tick":
      return randomTick(q);
    case "letter":
    case "mc":
    case "map":
      return randomLetter(q);
    default:
      return "";
  }
}

// ---- 卷路径探测（兼容原项目/整理版两种布局） ----
function resolvePaperPath(code) {
  if (code === "mt56") {
    return path.join(ROOT, "MT56-PartA-学生完整包", "data", "mt56_partA.json");
  }
  if (code === "2021HKDSE") {
    const cands = [
      path.join(ROOT, "2021HKDSE-新卷", "data", "2021HKDSE_P3A_partA.json"),
      path.join(ROOT, "MT56-PartA-学生完整包", "data", "2021HKDSE_P3A_partA.json"),
    ];
    return cands.find((p) => fs.existsSync(p));
  }
  return null;
}

const NAMES = ["陈晓彤", "李文轩", "张子晴", "黄俊豪", "林嘉怡", "何志强", "刘思敏", "吴卓颖"];
const DAY = 24 * 3600 * 1000;

// ---- 主流程 ----
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");

const paperArg = process.argv.find((a) => a.startsWith("--paper="))?.split("=")[1];
const want = paperArg ? [paperArg] : ["mt56", "2021HKDSE"];

const classes = db.prepare("SELECT * FROM classes LIMIT 1").get();
if (!classes) {
  console.error("未找到班级，请先正常启动一次服务器完成 seed。");
  process.exit(1);
}

const existingDemoUsers = db.prepare("SELECT * FROM users WHERE username LIKE 'demo_%' ORDER BY id").all();

function insertDemoUsersIfNeeded() {
  if (existingDemoUsers.length) return existingDemoUsers.map((u) => u.id);
  const insUser = db.prepare("INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, 'student', ?)");
  const insMember = db.prepare("INSERT INTO class_members (class_id, student_id) VALUES (?, ?)");
  const ids = [];
  for (let i = 0; i < NAMES.length; i++) {
    const r = insUser.run(`demo${String(i + 1).padStart(2, "0")}`, hashPassword("demo123"), NAMES[i]);
    const sid = Number(r.lastInsertRowid);
    insMember.run(classes.id, sid);
    ids.push(sid);
    console.log(`学生 ${NAMES[i]} (demo${String(i + 1).padStart(2, "0")})`);
  }
  return ids;
}

for (const code of want) {
  const paperPath = resolvePaperPath(code);
  if (!paperPath) {
    console.error(`⚠️ 卷 ${code} 的 JSON 未找到（${code === "2021HKDSE" ? "需先导入/放置题库文件" : "MT56 包缺失"}），跳过`);
    continue;
  }
  const paperJson = JSON.parse(fs.readFileSync(paperPath, "utf8"));
  const paper = db.prepare("SELECT * FROM papers WHERE code = ?").get(paperJson.id || code);
  if (!paper) {
    console.error(`未找到 paper ${code}，请先 import-paper 或正常启动服务器完成 seed。`);
    continue;
  }
  const qlist = collectQuestions(paperJson);

  // 幂等：该卷已有 demo 作答则跳过
  const demoIds = existingDemoUsers.map((u) => u.id);
  const ph = demoIds.length ? demoIds.map(() => "?").join(",") : "NULL";
  const existing = demoIds.length
    ? db.prepare(`SELECT COUNT(*) c FROM attempts WHERE paper_id = ? AND student_id IN (${ph}) AND status='graded'`).get(paper.id, ...demoIds).c
    : 0;
  if (existing > 0) {
    console.log(`卷 ${code}：已有 ${existing} 条 demo 作答，跳过。`);
    continue;
  }

  console.log(`\n▶ 生成卷 ${code} 演示作答（${qlist.length} 题）…`);
  const studentIds = insertDemoUsersIfNeeded();
  const now = Date.now();
  const insAttempt = db.prepare(
    `INSERT INTO attempts (student_id, paper_id, status, started_at, submitted_at, duration_sec,
       score, total_marks, correct_count, question_count, answers_snapshot_json)
     VALUES (?, ?, 'graded', ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insAnswer = db.prepare(
    `INSERT INTO answers (attempt_id, question_no, question_type, student_answer, reference_answer,
       is_correct, points_awarded, points_total, answered_at, duration_sec,
       audio_plays, signal_plays, cloze_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
  );

  db.exec("BEGIN");
  try {
    for (const sid of studentIds) {
      const attempts = code === "mt56" ? 1 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 2);
      for (let a = 0; a < attempts; a++) {
        const daysAgo = 1 + Math.floor(Math.random() * 13);
        const startMs = now - daysAgo * DAY - Math.floor(Math.random() * 8 * 3600 * 1000);
        const startedAt = new Date(startMs).toISOString().replace("T", " ").slice(0, 19);
        const durationSec = 600 + Math.floor(Math.random() * 1500);
        const submittedMs = startMs + durationSec * 1000;
        const submittedAt = new Date(submittedMs).toISOString().replace("T", " ").slice(0, 19);

        const A = {};
        const T = {};
        for (const q of qlist) {
          const v = randomAnswerFor(q);
          if (q.kind === "tick" || q.kind === "letter" || q.kind === "mc" || q.kind === "map") T[q.no] = v;
          else A[q.no] = v;
        }
        const snap = JSON.stringify({ A, T, STUDY_TASK: 4 });
        let correct = 0;
        const gradeMap = qlist.map((q) => {
          const g = gradeQuestion(q, A, T);
          if (g.ok) correct += 1;
          return g;
        });
        const ar = insAttempt.run(
          sid,
          paper.id,
          startedAt,
          submittedAt,
          durationSec,
          correct,
          qlist.length,
          correct,
          qlist.length,
          snap
        );
        const attemptId = Number(ar.lastInsertRowid);
        qlist.forEach((q, i) => {
          const g = gradeMap[i];
          const stu = g.empty ? "" : g.student != null ? String(g.student) : "";
          insAnswer.run(
            attemptId,
            q.no,
            q.kind,
            stu,
            String(g.key || ""),
            g.ok ? 1 : 0,
            g.ok ? 1 : 0,
            new Date(startMs + (i + 1) * 30000).toISOString().replace("T", " ").slice(0, 19),
            Math.floor(Math.random() * 120) + 5,
            Math.floor(Math.random() * 3),
            Math.floor(Math.random() * 3),
            Math.floor(Math.random() * 4)
          );
        });
      }
    }
    db.exec("COMMIT");
    console.log(`卷 ${code} 演示数据生成完毕（${studentIds.length} 名学生）。`);
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (_) {}
    console.error(`卷 ${code} 生成失败:`, err.message);
  }
}

console.log("\n完成。教师端登录后可切换卷查看。");
