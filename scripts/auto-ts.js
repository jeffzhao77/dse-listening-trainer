/**
 * 自动标注 ts 时间戳脚本（M4 · Whisper 方案）
 *
 * 原理：signal / cloze 在 JSON 里是已知文本 → 用本地 Whisper 对 task 音频做
 * 带时间戳的语音识别 → 把句子文本在识别结果里对齐 → 自动填 ts.signal / ts.answer。
 *
 * 用法:
 *   node scripts/auto-ts.js <json路径> [--whisper-bin <whisper可执行>] [--model <small|ggml-small.bin>] [--engine auto|cpp|openai] [--lang en]
 *
 * 前置（二选一装一个）：
 *   A. whisper.cpp（推荐，免 Python）: https://github.com/ggerganov/whisper.cpp/releases
 *      下载 whisper-cli（Windows 版）与模型 ggml-small.bin，如放到 scripts/whisper/ 下：
 *        --whisper-bin scripts/whisper/whisper-cli.exe --model scripts/whisper/ggml-small.bin
 *   B. openai-whisper（Python）:  pip install -U openai-whisper ffmpeg
 *      装好后 whisper 命令在 PATH 中即可（或 --whisper-bin 指向它）。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ---- 参数 ----
const args = process.argv.slice(2);
const file = args[0];
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const WHISPER_BIN = opt("--whisper-bin");
const MODEL = opt("--model");
const ENGINE = opt("--engine", "auto");
const LANG = opt("--lang", "en");
const ROOT = path.join(__dirname, "..");

// ---- 归一化 ----
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[‘’']/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(s) {
  return norm(s).split(" ").filter(Boolean);
}

// ---- Whisper 探测与调用 ----
function detectEngine(bin) {
  if (ENGINE !== "auto") return ENGINE;
  try {
    const out = execFileSync(bin, ["--help"], { encoding: "utf8", timeout: 20000 });
    // openai-whisper 有 --output_format/--output_dir；whisper.cpp 没有 → 其余默认 cpp
    return /--output_format|--output_dir/.test(out) ? "openai" : "cpp";
  } catch (_) {
    return "cpp";
  }
}
function findBin() {
  if (WHISPER_BIN) return path.resolve(WHISPER_BIN);
  // 项目内默认位置（scripts/whisper/）
  const local = [
    path.join(__dirname, "whisper", "bin", "Release", "whisper-cli.exe"),
    path.join(__dirname, "whisper", "whisper-cli.exe"),
    path.join(__dirname, "whisper", "whisper-cli"),
  ];
  for (const p of local) if (fs.existsSync(p)) return p;
  const candidates = ["whisper-cli", "whisper-cli.exe", "whisper", "whisper.exe"];
  for (const c of candidates) {
    try {
      execFileSync(c, ["--help"], { encoding: "utf8", timeout: 15000, stdio: "ignore" });
      return c;
    } catch (_) {}
  }
  return null;
}

function runWhisper(engine, bin, model, audio, outBase) {
  const outDir = path.dirname(outBase);
  if (engine === "cpp") {
    const m = model || path.join(__dirname, "whisper", "ggml-small.bin");
    execFileSync(
      bin,
      ["-m", m, "-f", audio, "-ojf", "-of", outBase, "-l", LANG, "-sow"],
      { encoding: "utf8", timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }
    );
    const data = JSON.parse(fs.readFileSync(outBase + ".json", "utf8"));
    // whisper.cpp 的 offsets 单位是毫秒 → 统一转成秒
    const fix = (o) => {
      if (o && typeof o.from === "number" && typeof o.to === "number") {
        o.from /= 1000;
        o.to /= 1000;
      }
    };
    for (const s of data.transcription || []) {
      fix(s.offsets);
      for (const tk of s.tokens || []) fix(tk.offsets);
      for (const wd of s.words || []) fix(wd.offsets);
    }
    return data;
  }
  // openai-whisper / faster-whisper CLI
  const m = model || "small";
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(
    bin,
    [audio, "--model", m, "--task", "transcribe", "--language", LANG,
     "--word_timestamps", "True", "--output_format", "verbose_json", "--output_dir", outDir],
    { encoding: "utf8", timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }
  );
  const base = path.basename(audio).replace(/\.[^.]+$/, "");
  return JSON.parse(fs.readFileSync(path.join(outDir, base + ".json"), "utf8"));
}

// ---- ASR 结果 → 词序列（优先 token 级，其次 word 级，最后 segment 级） ----
function expandWords(data) {
  const out = [];
  const segs = data.transcription || data.segments || [];
  for (const s of segs) {
    // token 级（whisper.cpp -ojf）
    if (Array.isArray(s.tokens) && s.tokens.length) {
      for (const tk of s.tokens) {
        const w = String(tk.text ?? "").trim();
        if (!w || w.startsWith("[")) continue; // 跳过 [_BEG_]/[_END_] 等特殊 token
        const t0 = tk.offsets?.from ?? tk.start;
        const t1 = tk.offsets?.to ?? tk.end;
        if (typeof t0 === "number" && typeof t1 === "number") out.push({ w: norm(w), t0, t1 });
      }
      continue;
    }
    // word 级（openai-whisper words[]）
    if (Array.isArray(s.words) && s.words.length) {
      for (const wd of s.words) {
        const w = String(wd.word ?? "").trim();
        if (!w) continue;
        const t0 = wd.offsets?.from ?? wd.start;
        const t1 = wd.offsets?.to ?? wd.end;
        if (typeof t0 === "number" && typeof t1 === "number") out.push({ w: norm(w), t0, t1 });
      }
      continue;
    }
    // segment 级（whisper.cpp -oj / 无细粒度）
    const text = String(s.text ?? "");
    const sStart = s.offsets?.from ?? s.start;
    const sEnd = s.offsets?.to ?? s.end;
    if (!text || typeof sStart !== "number" || typeof sEnd !== "number") continue;
    for (const tk of tokens(text)) out.push({ w: tk, t0: sStart, t1: sEnd });
  }
  return out;
}

// ---- 对齐：目标句子 → 起止时间 ----
function alignRange(toks, words, fromIdx) {
  if (!toks.length) return null;
  let best = null;
  for (let i = fromIdx; i < words.length; i++) {
    if (words[i].w !== toks[0]) continue;
    let j = 0, k = i;
    while (j < toks.length && k < words.length && words[k].w === toks[j]) {
      j++;
      k++;
    }
    if (j === toks.length) return { i0: i, i1: k - 1, fuzzy: false }; // 完全匹配
    if (j >= Math.ceil(toks.length * 0.6) && (!best || j > best.len)) {
      best = { i0: i, i1: k - 1, fuzzy: true, len: j };
    }
  }
  if (best) best.fuzzy = true;
  return best;
}

// ---- 主流程 ----
function main() {
  if (!file) {
    console.error("用法: node scripts/auto-ts.js <json路径> [--whisper-bin bin] [--model model] [--engine auto|cpp|openai] [--lang en]");
    process.exit(1);
  }
  const abs = path.resolve(file);
  let DATA;
  try {
    DATA = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    console.error("❌ JSON 无法解析:", e.message);
    process.exit(1);
  }

const bin = findBin();
if (!bin) {
  console.error(`
❌ 未找到 Whisper。请二选一安装：

  A. whisper.cpp（推荐，免 Python）:
     1) https://github.com/ggerganov/whisper.cpp/releases 下载 whisper-cli-x64 压缩包，解压
     2) https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin 下载模型
     3) 放到 scripts/whisper/ 后运行:
        node scripts/auto-ts.js ${file} --whisper-bin scripts/whisper/whisper-cli.exe --model scripts/whisper/ggml-small.bin

  B. openai-whisper（Python）:
     pip install -U openai-whisper ffmpeg
     然后直接运行（whisper 需在 PATH）:
     node scripts/auto-ts.js ${file}
`);
  process.exit(1);
}
const engine = detectEngine(bin);
console.log(`Whisper 引擎: ${engine === "cpp" ? "whisper.cpp" : "openai-whisper"} (${bin})`);
console.log(`语言: ${LANG} | 模型: ${MODEL || (engine === "cpp" ? "ggml-small.bin(默认)" : "small(默认)")}`);

const tmp = path.join(ROOT, "data", ".auto-ts-tmp");
fs.mkdirSync(tmp, { recursive: true });

let okCount = 0, fuzzyCount = 0, missCount = 0;
const misses = [];

for (const task of DATA.tasks || []) {
  if (!task.audio) {
    console.log(`\n⚠️ Task ${task.id} 没有 audio，跳过`);
    continue;
  }
  const audioAbs = path.resolve(path.dirname(abs), "..", task.audio);
  if (!fs.existsSync(audioAbs)) {
    console.log(`\n⚠️ Task ${task.id} 音频不存在: ${task.audio}，跳过`);
    misses.push({ task: task.id, reason: "音频缺失" });
    continue;
  }
  console.log(`\n▶ Task ${task.id}: ASR 识别 ${task.audio} ...`);
  let data;
  try {
    data = runWhisper(engine, bin, MODEL, audioAbs, path.join(tmp, `task${task.id}`));
  } catch (e) {
    console.error(`  ❌ ASR 失败: ${String(e.message).split("\n")[0]}`);
    misses.push({ task: task.id, reason: "ASR 失败: " + String(e.message).split("\n")[0] });
    continue;
  }
  const words = expandWords(data);
  console.log(`  识别完成，共 ${words.length} 词`);

  // 收集本 task 的题目（blocks 递归 + 特殊题型展开，与 shared/grade.js 一致）
  const qs = [];
  const walk = (b) => {
    if (Array.isArray(b)) return b.forEach(walk);
    if (b && typeof b === "object") {
      if (typeof b.no === "number" && b.ts) qs.push(b);
      for (const k in b) if (!["signal", "cloze", "ts", "answer"].includes(k)) walk(b[k]);
    }
  };
  for (const blk of task.blocks) walk(blk);
  qs.sort((a, b) => a.no - b.no);

  for (const q of qs) {
    const sigToks = tokens(q.signal);
    const clozeToks = tokens(q.cloze);
    // signal 从 0 独立搜（题号顺序 ≠ 音频顺序，不能用全局游标累进）
    let sigR = sigToks.length ? alignRange(sigToks, words, 0) : null;
    let clozeR = clozeToks.length ? alignRange(clozeToks, words, sigR ? sigR.i1 + 1 : 0) : null;
    // 答案句在信号句之后找不到 → 全局回退（覆盖 answer 先于 signal 的乱序/标反情况）
    if (!clozeR && clozeToks.length) clozeR = alignRange(clozeToks, words, 0);
    const orderSuspicious =
      !!sigR && !!clozeR && words[sigR.i0].t0 > words[clozeR.i0].t0;

    if (!sigR || !clozeR) {
      missCount++;
      misses.push({ task: task.id, no: q.no, signal: !!sigR, cloze: !!clozeR });
      console.log(`  ⚠️ 题 #${q.no}: ${!sigR ? "signal 未对齐" : ""}${!sigR && !clozeR ? " / " : ""}${!clozeR ? "cloze 未对齐" : ""}`);
      continue;
    }
    if (orderSuspicious) {
      misses.push({ task: task.id, no: q.no, reason: "signal 晚于 answer，顺序可疑（可能是标反或题目乱序），请人工核对" });
    }
    if (sigR.fuzzy || clozeR.fuzzy) fuzzyCount++;
    else okCount++;
    q.ts = {
      signal: [+words[sigR.i0].t0.toFixed(2), +words[sigR.i1].t1.toFixed(2)],
      answer: [+words[clozeR.i0].t0.toFixed(2), +words[clozeR.i1].t1.toFixed(2)],
    };
    const flag = sigR.fuzzy || clozeR.fuzzy ? " （模糊匹配，建议人工复核）" : orderSuspicious ? " （⚠️ 顺序可疑）" : "";
    console.log(`  ✓ 题 #${q.no}: ts=[${q.ts.signal}]/[${q.ts.answer}]${flag}`);
  }
}

fs.writeFileSync(abs, JSON.stringify(DATA, null, 2), "utf8");
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n========== 汇总 ==========`);
console.log(`完全匹配: ${okCount} | 模糊匹配(需复核): ${fuzzyCount} | 未对齐: ${missCount}`);
if (misses.length) {
  console.log(`\n未对齐明细（需人工补 ts）:`);
  misses.forEach((m) => console.log(`  - Task ${m.task}${m.no ? " 题 #" + m.no : ""}: ${m.reason || "signal/cloze 与识别文本不一致，请核对 signal/cloze 文本或人工标注"}`));
}
console.log(`\n已写回: ${abs}`);
console.log("下一步: node scripts/validate-paper.js " + file.replace(/\\/g, "/") + " --strict");
}

module.exports = { norm, tokens, expandWords, alignRange };
if (require.main === module) main();
