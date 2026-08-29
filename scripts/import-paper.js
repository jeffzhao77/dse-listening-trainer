/**
 * 新卷导入脚本（M4 题库导入 · 第三步）
 *
 * 用法: node scripts/import-paper.js <json路径> [--status published|draft] [--code xxx]
 *   - 已存在同 code 试卷时：更新元数据、version+1、重建题目索引（内容仍以 JSON 文件为权威）
 *   - 默认 status=published（学生端可作答）；也可先 draft 再手动改
 *
 * 注意：请先停止服务器再运行（SQLite 单写者），导入后重启服务器生效。
 */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { collectQuestions } = require("../shared/grade");

const ROOT = path.join(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "dse.sqlite");

const file = process.argv[2];
const statusArg = process.argv.find((a) => a.startsWith("--status="))?.split("=")[1] || "published";
const codeArg = process.argv.find((a) => a.startsWith("--code="))?.split("=")[1] || null;
if (!file) {
  console.error("用法: node scripts/import-paper.js <json路径> [--status=published|draft] [--code=xxx]");
  process.exit(1);
}
if (!["published", "draft"].includes(statusArg)) {
  console.error("--status 只允许 published 或 draft");
  process.exit(1);
}

const abs = path.resolve(file);
const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
let DATA;
try {
  DATA = JSON.parse(fs.readFileSync(abs, "utf8"));
} catch (e) {
  console.error("❌ JSON 无法解析:", e.message);
  process.exit(1);
}
const code = codeArg || DATA.id;

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");

// 试卷元数据 upsert
const existing = db.prepare("SELECT * FROM papers WHERE code = ?").get(code);
const qlist = collectQuestions(DATA);
let paperId;
if (existing) {
  const newVersion = (existing.version || 1) + 1;
  db.prepare(
    `UPDATE papers SET year=?, title=?, total_marks=?, version=?, content_json_path=?, status=? WHERE id=?`
  ).run(
    DATA.year ?? null,
    DATA.title,
    DATA.totalMarks ?? qlist.length,
    newVersion,
    rel,
    statusArg,
    existing.id
  );
  paperId = existing.id;
  console.log(`↻ 试卷已存在，升级为 version ${newVersion}: ${code}`);
} else {
  const r = db
    .prepare(
      `INSERT INTO papers (code, year, paper_part, title, total_marks, version, audio_base_path, content_json_path, status)
       VALUES (?, ?, 'A', ?, ?, 1, '/papers/mt56/', ?, ?)`
    )
    .run(code, DATA.year ?? null, DATA.title, DATA.totalMarks ?? qlist.length, rel, statusArg);
  paperId = Number(r.lastInsertRowid);
  console.log(`+ 新建试卷 #${paperId}: ${code}`);
}

// 重建题目索引（内容权威在 JSON，questions 表只是索引）
db.prepare("DELETE FROM questions WHERE paper_id = ?").run(paperId);
const insQ = db.prepare(
  `INSERT INTO questions (paper_id, question_no, type, kind, points, reference_answer_json, ts_json)
   VALUES (?, ?, ?, ?, 1, ?, ?)`
);
for (const q of qlist) {
  insQ.run(
    paperId,
    q.no,
    q.type || q.kind || null,
    q.kind || null,
    JSON.stringify(q.answer ?? null),
    JSON.stringify(q.ts ?? null)
  );
}

// 验证 loadPaperJson 链路（与服务器同源）
const loaded = require("../server/db").loadPaperJson(db, paperId);
const ok = loaded && Array.isArray(loaded.data.tasks) && collectQuestions(loaded.data).length === qlist.length;

console.log(`题目索引: ${qlist.length} 题 → questions 表`);
console.log(`状态: ${statusArg}${statusArg === "published" ? "（学生端可作答）" : "（草稿，需改 published）"}`);
console.log(ok ? "✅ 导入完成，loadPaperJson 验证通过" : "⚠️ 导入完成但 loadPaperJson 验证异常，请检查 JSON");
console.log("\n请重启服务器后生效。");
