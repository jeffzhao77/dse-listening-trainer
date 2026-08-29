/**
 * 新卷校验脚本（M4 题库导入 · 第二步）
 *
 * 用法: node scripts/validate-paper.js <json路径> [--strict]
 *   --strict: ts.signal/ts.answer 缺失时判为错误（精听必需）
 *   默认（宽松）: ts 缺失仅告警（可先跑通作答流程，后补精听时间戳）
 *
 * 检查项：
 *   1. JSON 可解析、顶层必填字段
 *   2. 题号从 1 连续、无重复（通过 shared/grade.js collectQuestions 收集）
 *   3. 每题有答案 answer
 *   4. ts 区间合法（signal[0]<signal[1]，answer[0]<answer[1]）
 *   5. 音频文件存在（相对题库包根目录）
 *   6. blocks 里引用的图片文件存在
 */
const fs = require("fs");
const path = require("path");
const { collectQuestions } = require("../shared/grade");

const file = process.argv[2];
const strict = process.argv.includes("--strict");
if (!file) {
  console.error("用法: node scripts/validate-paper.js <json路径> [--strict]");
  process.exit(1);
}
const abs = path.resolve(file);
const jsonDir = path.dirname(abs);
const pkgRoot = path.resolve(jsonDir, ".."); // data/ 的上一级 = 题库包根

let errors = [];
let warns = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warns.push(msg);
}

// ---- 1. 顶层结构 ----
let DATA;
try {
  DATA = JSON.parse(fs.readFileSync(abs, "utf8"));
} catch (e) {
  console.error("❌ JSON 无法解析:", e.message);
  process.exit(1);
}
for (const k of ["id", "title", "totalMarks", "situation", "tasks"]) {
  if (DATA[k] == null || DATA[k] === "") fail(`缺少顶层字段: ${k}`);
}
if (!Array.isArray(DATA.tasks) || !DATA.tasks.length) fail("tasks 必须是非空数组");

// ---- 2/3. 题目收集与题号 ----
let qlist = [];
try {
  qlist = collectQuestions(DATA);
} catch (e) {
  fail("collectQuestions 解析失败: " + e.message);
}
if (qlist.length) {
  const nos = qlist.map((q) => q.no).sort((a, b) => a - b);
  for (let i = 0; i < nos.length; i++) {
    if (nos[i] !== i + 1) fail(`题号不连续: 期望 ${i + 1}，实际 ${nos[i]}（请检查题目 no 字段）`);
  }
  const dup = nos.filter((n, i) => nos.indexOf(n) !== i);
  if (dup.length) fail(`题号重复: ${[...new Set(dup)].join(", ")}`);
  qlist.forEach((q) => {
    if (q.answer == null || (Array.isArray(q.answer) && !q.answer.length) || q.answer === "")
      fail(`题 #${q.no} 缺少答案 answer`);
    if (!q.ts) {
      strict ? fail(`题 #${q.no} 缺少 ts（精听必需）`) : warn(`题 #${q.no} 缺少 ts，精听暂不可用（可后补）`);
    } else {
      const ts = q.ts;
      const check = (key) => {
        const v = ts[key];
        if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "number" || typeof v[1] !== "number") {
          fail(`题 #${q.no} 的 ts.${key} 必须是 [起, 止] 两个数字`);
        } else if (v[0] < 0 || v[0] >= v[1]) {
          fail(`题 #${q.no} 的 ts.${key} 区间非法: [${v[0]}, ${v[1]}]`);
        }
      };
      check("signal");
      check("answer");
    }
  });
  if (qlist.length !== DATA.totalMarks) warn(`实际题目数 ${qlist.length} ≠ totalMarks ${DATA.totalMarks}`);
}

// ---- 4. 音频文件 ----
for (const t of DATA.tasks || []) {
  if (!t.audio) {
    warn(`Task ${t.id} 缺少 audio 路径`);
    continue;
  }
  const ap = path.resolve(pkgRoot, t.audio);
  if (!fs.existsSync(ap)) warn(`音频不存在: ${t.audio}（请放入 ${path.relative(ROOT_DIR(), ap)}）`);
}

// ---- 5. 图片文件 ----
function walkImgs(obj) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    for (const k in o) {
      const v = o[k];
      if (typeof v === "string" && /\.(png|jpe?g|gif|webp)$/i.test(v)) out.push(v);
      else walk(v);
    }
  };
  walk(obj);
  return out;
}
for (const img of walkImgs(DATA)) {
  if (img.startsWith("http")) continue;
  const ip = path.resolve(pkgRoot, img);
  if (!fs.existsSync(ip)) warn(`图片不存在: ${img}`);
}

function ROOT_DIR() {
  return path.join(__dirname, "..");
}

// ---- 汇总 ----
console.log(`\n校验: ${path.relative(process.cwd(), abs)}（${strict ? "严格" : "宽松"}模式）`);
console.log(`题目数: ${qlist.length}${DATA.totalMarks ? ` / totalMarks=${DATA.totalMarks}` : ""}`);
if (warns.length) {
  console.log(`\n⚠️  告警 ${warns.length} 项（不影响导入，建议处理）:`);
  warns.forEach((w) => console.log("  - " + w));
}
if (errors.length) {
  console.log(`\n❌ 错误 ${errors.length} 项（需修复后才能导入）:`);
  errors.forEach((e) => console.log("  - " + e));
  process.exit(1);
}
console.log("\n✅ 校验通过，可以导入：");
console.log(`   node scripts/import-paper.js ${file.replace(/\\/g, "/")}`);
