/**
 * fill-ts —— 题级 ts 填充（工具链最后一步：产出 demo 精听可用的题库 JSON）
 *
 * 输入：题库 JSON（每题有 signal/cloze 文本）+ audio-align 产出的 aligned.json（逐字稿句子 ↔ 时间轴）
 * 原理：signal/cloze 是从逐字稿摘录的句子，与 aligned.json 的句子同源 → 文本相似度匹配 → 填 ts
 *
 * 用法:
 *   node scripts/fill-ts.js <题库JSON> <aligned.json> [--out 输出.json]
 *   默认输出 <题库名>_ts.json（不改原文件）
 *   匹配不到（相似度 < 阈值）的题 ts 留 [0,0] 并在汇总中报告，供人工补
 */
const fs = require("fs");
const path = require("path");
const { splitSentences, tokens } = require("./whisper-common");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const jsonFile = args[0];
const alignedFile = args[1];
const outArg = opt("--out");
const THRESHOLD = 0.55;

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

// 句子相似度（词重叠率，min 分母）
function sentSim(toksA, toksB) {
  if (!toksA.length || !toksB.length) return 0;
  const setB = new Set(toksB);
  let hit = 0;
  for (const w of toksA) if (setB.has(w)) hit++;
  return hit / Math.min(toksA.length, toksB.length);
}

// 在 aligned 句子里找最相似句（限制在指定 task 内）
function findInTask(lines, text, taskId) {
  const toks = tokens(text);
  if (!toks.length) return null;
  let best = null, bestSim = 0;
  for (const l of lines) {
    if (l.taskId !== taskId) continue;
    if (l.match === "missing") continue;
    const sim = sentSim(toks, tokens(l.text));
    if (sim > bestSim) { bestSim = sim; best = l; }
  }
  if (best && bestSim >= THRESHOLD) {
    return { start: best.start, end: best.end, sim: +bestSim.toFixed(2), text: best.text };
  }
  return null;
}

function main() {
  if (!jsonFile || !alignedFile) {
    console.error("用法: node scripts/fill-ts.js <题库JSON> <aligned.json> [--out 输出.json]");
    process.exit(1);
  }
  const DATA = JSON.parse(fs.readFileSync(path.resolve(jsonFile), "utf8"));
  const ALIGN = JSON.parse(fs.readFileSync(path.resolve(alignedFile), "utf8"));

  // aligned 句子带上 taskId（flatten）+ 每 Task 的绝对起始（用于转相对 Task 音频的时间）
  const lines = [];
  const taskStartOf = {};
  for (const t of ALIGN.tasks || []) {
    taskStartOf[t.id] = t.start || 0;
    for (const l of t.lines || []) {
      if (l.match === "segment") continue; // 合并行不参与匹配
      lines.push({ ...l, taskId: t.id });
    }
  }

  let okCount = 0, missList = [];
  // 遍历所有题（blocks 递归 + 特殊题型展开，与 shared/grade.js 一致）
  const walk = (b, taskId, pathName) => {
    if (Array.isArray(b)) return b.forEach((x) => walk(x, taskId, pathName));
    if (b && typeof b === "object") {
      if (typeof b.no === "number" && (b.signal || b.cloze)) {
        const sig = b.signal ? findInTask(lines, b.signal, taskId) : null;
        const clo = b.cloze ? findInTask(lines, b.cloze, taskId) : null;
        const had = b.ts;
        const off = taskStartOf[taskId] || 0; // 转相对 Task 音频的时间
        b.ts = {
          signal: sig ? [+(sig.start - off).toFixed(2), +(sig.end - off).toFixed(2)] : (had?.signal || [0, 0]),
          answer: clo ? [+(clo.start - off).toFixed(2), +(clo.end - off).toFixed(2)] : (had?.answer || [0, 0]),
        };
        if (sig && clo) okCount++;
        else missList.push({ no: b.no, task: taskId, signal: !!sig, cloze: !!clo, path: pathName });
      }
      for (const k in b) {
        if (["signal", "cloze", "ts", "answer", "label", "prefix"].includes(k)) continue;
        walk(b[k], taskId, pathName + "." + k);
      }
    }
  };
  for (const t of DATA.tasks || []) {
    for (const blk of t.blocks || []) walk(blk, t.id, `task${t.id}`);
  }

  const outPath = path.resolve(outArg || jsonFile.replace(/\.json$/, "_ts.json"));
  fs.writeFileSync(outPath, JSON.stringify(DATA, null, 2), "utf8");
  console.log(`✅ 题级 ts 填充完成：${okCount} 题 signal+answer 均命中`);
  if (missList.length) {
    console.log(`⚠️ ${missList.length} 题未完全命中（ts 保留原值或 [0,0]，需人工补）:`);
    missList.forEach((m) => console.log(`  - Task ${m.task} 题 #${m.no}: ${m.signal ? "" : "signal 未命中 "}${m.cloze ? "" : "cloze 未命中"}`));
  }
  console.log("已写回: " + outPath);
}

main();
