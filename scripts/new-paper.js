/**
 * 新卷模板生成器（M4 题库导入 · 第一步）
 *
 * 用法: node scripts/new-paper.js
 * 交互式回答几个问题后，在 MT56-PartA-学生完整包/data/ 下生成一份可填写的
 * 新卷 JSON 骨架。生成后请按《新卷导入指南.md》逐题填写，再运行：
 *   node scripts/validate-paper.js <json路径>
 *   node scripts/import-paper.js    <json路径>
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.join(__dirname, "..");
const PKG_DIR = path.join(ROOT, "MT56-PartA-学生完整包");
const DATA_DIR = path.join(PKG_DIR, "data");
const AUDIO_DIR = path.join(PKG_DIR, "audio");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q, def) {
  return new Promise((resolve) => {
    rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => resolve(a.trim() || def || ""));
  });
}
function askInt(q, def, min = 1) {
  return ask(q, String(def)).then((a) => {
    const n = parseInt(a, 10);
    return Number.isFinite(n) && n >= min ? n : def;
  });
}

function makeTsExample() {
  return { signal: [10.0, 14.0], answer: [14.0, 19.0] };
}

function makeFillBlock(no, label) {
  return {
    no,
    type: "fill",
    label,
    answer: ["参考答案（可接受变体用 / 分隔）"],
    signal: "答案出现前的提示句（人工听音频填写）",
    cloze: "学生需要精听的完整答案句（人工听音频填写）",
    ts: makeTsExample(),
  };
}

function arg(name) {
  const i = process.argv.findIndex((a) => a === name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function argList(name) {
  const i = process.argv.findIndex((a) => a === name);
  return i >= 0 ? process.argv.slice(i + 1) : [];
}

async function main() {
  console.log("\n=== 新卷模板生成器 ===\n");

  // 非交互模式: node scripts/new-paper.js --id demo2 --year 2023 --title "x" --total 10 --tasks 2 --task-titles "A" "B"
  if (arg("--id")) {
    const id = arg("--id");
    const year = parseInt(arg("--year"), 10) || new Date().getFullYear();
    const title = arg("--title") || `${id} Part A`;
    const totalMarks = parseInt(arg("--total"), 10) || 12;
    const taskCount = parseInt(arg("--tasks"), 10) || 2;
    const taskTitles = argList("--task-titles");
    const situation = arg("--situation") || "请填写整卷情境，如：实习生为出版社调研香港美食。";
    buildAndWrite({ id, year, title, totalMarks, situation, taskCount, taskTitles });
    return;
  }

  const id = await ask("试卷代码 id（如 2023A / demo2）", "demo2");
  const year = await askInt("年份", new Date().getFullYear());
  const title = await ask("试卷标题（如 Pineapple Buns (Mock MT56)）", `${id} Part A`);
  const totalMarks = await askInt("总题数（决定题目数量，不是总分）", 12);
  const situation = await ask("情境描述 situation（一句话）", "请填写整卷情境，如：实习生为出版社调研香港美食。");
  const taskCount = await askInt("Task 数量", 2);
  const taskTitles = [];
  for (let t = 1; t <= taskCount; t++) {
    taskTitles.push(await ask(`Task ${t} 标题`, `Task ${t}`));
  }
  buildAndWrite({ id, year, title, totalMarks, situation, taskCount, taskTitles });
  rl.close();
}

function buildAndWrite({ id, year, title, totalMarks, situation, taskCount, taskTitles }) {
  const speakers = { A: "Announcer" };
  const tasks = [];
  for (let t = 1; t <= taskCount; t++) {
    const tTitle = taskTitles[t - 1] || `Task ${t}`;
    const tMarks = Math.ceil(totalMarks / taskCount);
    tasks.push({
      id: t,
      title: tTitle,
      marks: tMarks,
      audio: `audio/${id}_task${t}.mp3`,
      instructions: `请填写 Task ${t} 的答题指引（从 PDF 抄录）`,
      tapescript: [
        { sp: "A", t: "请填写逐字稿（按说话人分段，sp 用 speakers 里的键）" },
      ],
      blocks: [],
    });
  }

  // 题号从 1 连续分配到各 task
  let no = 1;
  for (const task of tasks) {
    for (let i = 0; i < task.marks; i++) {
      task.blocks.push(makeFillBlock(no, `(${no})`));
      no++;
    }
  }

  const json = {
    id,
    paper: "Paper 3 (Listening & Integrated Skills) — Part A",
    title,
    perTaskAudio: true,
    totalMarks: totalMarks,
    situation,
    speakers,
    tasks,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, `${id}_partA.json`);
  fs.writeFileSync(outPath, JSON.stringify(json, null, 2), "utf8");

  console.log(`\n✅ 已生成: ${path.relative(ROOT, outPath)}`);
  console.log(`   （${taskCount} 个 Task × 每题一个 fill 示例，共 ${totalMarks} 题）`);
  console.log("\n下一步：");
  console.log(`  1. 用编辑器打开该文件，把示例题改成真题内容（题型可用 fill/mc/map/tick/steporder/maplabel/table）`);
  console.log(`  2. 音频放入: MT56-PartA-学生完整包/audio/${id}_task*.mp3`);
  console.log(`  3. 校验:   node scripts/validate-paper.js ${path.relative(ROOT, outPath).replace(/\\/g, "/")}`);
  console.log(`  4. 导入:   node scripts/import-paper.js ${path.relative(ROOT, outPath).replace(/\\/g, "/")}`);
  console.log("详细说明见《新卷导入指南.md》\n");
}

main().catch((e) => {
  console.error("生成失败:", e.message);
  process.exit(1);
});
