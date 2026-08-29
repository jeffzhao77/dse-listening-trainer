/**
 * audio-align —— 音频分句 + 真实文本对齐（工具链第 1 步）
 *
 * 原理（句子级对齐）：
 *   1. 语音模型（whisper.cpp / OpenAI Whisper / 阿里云 paraformer）对完整录音转写，
 *      产出带时间戳的句子（segment 级，时间戳可靠）
 *   2. 用「播报词 Task N」粗定位每个 Task 的音频区间
 *   3. 每个 Task 的 tapescript（真实逐字稿）按子句，与 ASR 句子做「文本相似度匹配」
 *      ——文稿句子 ↔ ASR 句子大致对应，句子起止时间直接采用 ASR 句子的时间
 *      ——不依赖词级时间戳，天然容忍 ASR 切词/拼写差异（"we'd better"→"webetter" 不影响）
 *   4. 产出集成文件 aligned.json：每句真实文本 ↔ 音频起止时间 ↔ 说话人 + Task 边界
 *
 * 用法:
 *   node scripts/audio-align.js <题库JSON> <完整录音mp3|公网URL> [--out 输出.json] [--asr local|cloud|dashscope] [--api-key KEY] [--base-url URL] [--model MODEL] [--whisper-bin bin] [--engine auto|cpp|openai] [--lang en] [--skip-asr]
 *
 *   --asr cloud 走 OpenAI Whisper API；--asr dashscope 走阿里云语音识别（本地音频自动上传 OSS）；
 *   默认 local 走 whisper.cpp。环境变量 ASR_PROVIDER 也可指定。
 *   --skip-asr 复用 data/.audio-align-tmp/ 里已有的转写中间产物（中断续跑/调参时省时省钱）。
 */
const fs = require("fs");
const path = require("path");
const { findBin, transcribe, parseAsrFile, splitSentences, tokens } = require("./whisper-common");

const ROOT = path.join(__dirname, "..");

// ---- 参数 ----
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const file = args[0]; // 题库 JSON（提供 tapescript 真实文本）
const audio = args[1]; // 完整录音（本地路径或公网 URL）
const outArg = opt("--out");
const skipAsr = args.includes("--skip-asr");
const asrFile = opt("--asr-file"); // 外部转写文件（SRT/VTT/verbose_json），替代自转写

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

// ---- 句子相似度：词重叠率（min 分母，短句也敏感；精确词匹配，避免远处误配） ----
function sentSim(toksA, toksB) {
  if (!toksA.length || !toksB.length) return 0;
  const setB = new Set(toksB);
  let hit = 0;
  for (const w of toksA) if (setB.has(w)) hit++;
  return hit / Math.min(toksA.length, toksB.length);
}

// ---- 播报词定位：扫 ASR 句子文本找 "task <N>"（数字或英文数字） ----
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function findTaskBoundaries(asrSents) {
  const bounds = new Map(); // taskId -> { sentIdx, t0 }
  for (let i = 0; i < asrSents.length; i++) {
    const m = String(asrSents[i].text || "").match(/\btask\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b/i);
    if (!m) continue;
    const num = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUM_WORDS[m[1].toLowerCase()];
    if (num && num >= 1 && num <= 10 && !bounds.has(num)) {
      bounds.set(num, { sentIdx: i, t0: asrSents[i].start });
    }
  }
  return bounds;
}

// ---- 全局序列对齐（Needleman-Wunsch 风格）：文稿句序列 ↔ ASR 句序列 最优匹配 ----
// 转移：匹配（sim≥0.5，得分=sim）/ 跳过 ASR 句（0，播报插话）/ 跳过文稿句（-0.3，missing）
// 无窗口、无游标，不会连环漏句
function dpAlign(scriptSents, asrSents, segStartIdx, segEndIdx) {
  const A = asrSents.slice(segStartIdx, segEndIdx + 1);
  const n = scriptSents.length, m = A.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const op = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 0=匹配 1=跳ASR 2=跳文稿
  for (let i = 1; i <= n; i++) { dp[i][0] = -0.3 * i; op[i][0] = 2; }
  for (let j = 1; j <= m; j++) { dp[0][j] = 0; op[0][j] = 1; }
  const sims = Array.from({ length: n }, () => new Float64Array(m));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = sentSim(scriptSents[i - 1].toks, A[j - 1].toks);
      sims[i - 1][j - 1] = sim;
      let best = -Infinity, bestOp = 0;
      if (sim >= 0.5) {
        const v = dp[i - 1][j - 1] + sim;
        if (v > best) { best = v; bestOp = 0; }
      }
      const vA = dp[i][j - 1];
      if (vA > best) { best = vA; bestOp = 1; }
      const vS = dp[i - 1][j] - 0.3;
      if (vS > best) { best = vS; bestOp = 2; }
      dp[i][j] = best;
      op[i][j] = bestOp;
    }
  }
  // 回溯
  const results = new Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const o = op[i][j];
    if (o === 0) {
      results[i - 1] = { asrIdx: segStartIdx + (j - 1), sim: sims[i - 1][j - 1] };
      i--; j--;
    } else if (o === 1) {
      j--;
    } else {
      results[i - 1] = null;
      i--;
    }
  }
  return results;
}

// ---- 主流程 ----
async function main() {
  if (!file || !audio) {
    console.error("用法: node scripts/audio-align.js <题库JSON> <完整录音mp3|公网URL> [--out out.json] [--asr local|cloud|dashscope] [--api-key KEY] [--base-url URL] [--model MODEL] [--whisper-bin bin] [--engine auto|cpp|openai] [--lang en] [--skip-asr]");
    process.exit(1);
  }
  const jsonAbs = path.resolve(file);
  const isUrl = /^https?:\/\//i.test(audio);
  const audioAbs = isUrl ? audio : path.resolve(audio);
  if (!fs.existsSync(jsonAbs)) fail(`题库 JSON 不存在: ${jsonAbs}`);
  if (!isUrl && !fs.existsSync(audioAbs)) fail(`完整录音不存在: ${audioAbs}`);

  const provider = opt("--asr") || process.env.ASR_PROVIDER || "local";
  const bin = provider === "cloud" || provider === "dashscope" ? null : findBin(opt("--whisper-bin"));
  if (!bin && provider !== "cloud" && provider !== "dashscope") fail("未找到 whisper，请先安装 whisper.cpp 或 openai-whisper（见新卷导入指南）");
  const engine = opt("--engine", "auto");
  const lang = opt("--lang", "en");

  const DATA = JSON.parse(fs.readFileSync(jsonAbs, "utf8"));
  if (!Array.isArray(DATA.tasks)) fail("题库 JSON 缺少 tasks 数组");
  const hasTapescript = DATA.tasks.some((t) => Array.isArray(t.tapescript) && t.tapescript.length);

  console.log(`ASR: ${provider}${bin ? " (" + bin + ")" : ""} | 语言: ${lang}`);
  console.log(`题库: ${jsonAbs}`);
  console.log(`录音: ${audioAbs}${isUrl ? "（公网 URL）" : ""}`);
  if (!hasTapescript) console.log("⚠️ 题库里没有 tapescript，将退回按播报词定位 Task（效果较差）");

  // ---- 1. 转写（带缓存；或导入外部转写文件） ----
  const tmp = path.join(ROOT, "data", ".audio-align-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const asrBase = path.join(tmp, "full");
  let data;
  if (asrFile) {
    console.log("导入外部转写: " + asrFile);
    data = { transcription: parseAsrFile(path.resolve(asrFile)), source: "import" };
    fs.writeFileSync(asrBase + ".json", JSON.stringify(data, null, 2), "utf8");
  } else if (skipAsr && fs.existsSync(asrBase + ".json")) {
    console.log("复用已有转写: " + asrBase + ".json");
    data = JSON.parse(fs.readFileSync(asrBase + ".json", "utf8"));
  } else {
    console.log("\n▶ 转写完整录音…（云端约 1-3 分钟；本地 CPU 约等于音频时长）");
    try {
      data = await transcribe(audioAbs, asrBase, {
        provider,
        whisperBin: bin,
        engine,
        lang,
        model: opt("--model"),
        apiKey: opt("--api-key"),
        baseURL: opt("--base-url"),
      });
    } catch (e) {
      console.error("  ASR 详细错误:");
      console.error(String(e.message || e).slice(0, 2000));
      fail("ASR 失败（检查录音格式与 API 配置）");
    }
  }

  // ASR 句子（句子级时间戳；words 仅作参考，不依赖）
  const asrSents = (data.transcription || []).map((s) => ({
    text: s.text || "",
    toks: tokens(s.text),
    start: s.offsets?.from ?? s.start ?? 0,
    end: s.offsets?.to ?? s.end ?? 0,
  }));
  console.log(`  识别完成，共 ${asrSents.length} 句（${(asrSents.length ? asrSents[asrSents.length - 1].end : 0).toFixed(1)}s）`);

  // 探测本地音频物理时长（URL 场景无法探测，用末句时间兜底）
  let audioDuration = null;
  if (!isUrl) {
    try {
      const { execFileSync } = require("child_process");
      let ff = null;
      try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); ff = "ffmpeg"; } catch (_) {}
      if (!ff) try { ff = require("@ffmpeg-installer/ffmpeg").path; } catch (_) {}
      if (ff) {
        let out = "";
        try {
          out = execFileSync(ff, ["-i", audioAbs], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
        } catch (e) {
          out = String(e.stderr || "");
        }
        const m = String(out).match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
        if (m) audioDuration = +m[1] * 3600 + +m[2] * 60 + +m[3];
      }
    } catch (_) {}
    if (audioDuration) console.log(`  音频物理时长: ${audioDuration.toFixed(1)}s`);
  }

  // ---- 2. 播报词定位 Task 边界 ----
  const bounds = findTaskBoundaries(asrSents);
  if (bounds.size) {
    console.log(`  播报词定位 Task 边界: ${[...bounds.entries()].map(([id, b]) => `Task ${id} @${b.t0.toFixed(1)}s`).join("，")}`);
  } else {
    console.log("  ⚠️ 未找到 Task N 播报词，退化为全文顺序对齐（边界可能不准）");
  }

  // ---- 3. 每个 Task：文稿子句 ↔ ASR 句子 贪心相似度匹配 ----
  const result = { id: DATA.id || path.basename(jsonAbs, ".json"), title: DATA.title || "", audio, json: file };
  result.tasks = [];
  let okCount = 0, fuzzyCount = 0, missCount = 0;

  for (let ti = 0; ti < DATA.tasks.length; ti++) {
    const task = DATA.tasks[ti];
    console.log(`\n▶ Task ${task.id}: ${task.title || ""}`);
    const tapeLines = Array.isArray(task.tapescript) ? task.tapescript : [];

    // 本 task 的 ASR 句子区间：[播报词句, 下一个播报词句)
    const b = bounds.get(task.id);
    const bNext = bounds.get(task.id + 1);
    const segStartIdx = b ? b.sentIdx + 1 : 0;
    const segEndIdx = bNext ? bNext.sentIdx - 1 : asrSents.length - 1;

    // 收集本 task 的文稿子句（保留段落归属）
    const scriptSents = [];
    tapeLines.forEach((seg, segIdx) => {
      for (const sent of splitSentences(seg.t)) {
        const toks = tokens(sent);
        if (toks.length) scriptSents.push({ sp: seg.sp, text: sent, toks, segIdx, start: null, end: null, match: null, near: null });
      }
    });

    // 全局序列对齐（DP）：文稿句 ↔ ASR 句 最优匹配，无窗口无游标
    const alignResults = dpAlign(scriptSents, asrSents, segStartIdx, segEndIdx);
    let taskStart = null, taskEnd = null;
    scriptSents.forEach((s, idx) => {
      const r = alignResults[idx];
      if (r) {
        const a = asrSents[r.asrIdx];
        s.match = r.sim >= 0.99 ? "exact" : "fuzzy";
        s.start = a.start;
        s.end = a.end;
        if (r.sim >= 0.99) okCount++;
        else fuzzyCount++;
        if (taskStart === null || a.start < taskStart) taskStart = a.start;
        if (taskEnd === null || a.end > taskEnd) taskEnd = a.end;
      } else {
        s.match = "missing";
        // near 提示：在 ASR 区间找最相似句（供人工复核定位）
        let bSim = 0, bIdx = -1;
        for (let k = segStartIdx; k <= segEndIdx; k++) {
          const sim = sentSim(s.toks, asrSents[k].toks);
          if (sim > bSim) { bSim = sim; bIdx = k; }
        }
        s.near = bIdx >= 0
          ? { start: asrSents[bIdx].start, end: asrSents[bIdx].end, text: asrSents[bIdx].text, sim: +bSim.toFixed(2) }
          : null;
        missCount++;
      }
    });

    // 按段落顺序组装 lines（子句 + segment 合并行）
    const lines = [];
    let sIdx = 0;
    tapeLines.forEach((seg, segIdx) => {
      const segTimes = [];
      let segEnd = null;
      while (sIdx < scriptSents.length && scriptSents[sIdx].segIdx === segIdx) {
        const s = scriptSents[sIdx++];
        lines.push({ sp: s.sp, text: s.text, start: s.start, end: s.end, match: s.match, near: s.near });
        if (s.match !== "missing") { segTimes.push([s.start, s.end]); segEnd = s.end; }
      }
      if (segTimes.length) {
        lines.push({
          sp: seg.sp,
          text: seg.t,
          start: segTimes[0][0],
          end: segEnd,
          match: "segment",
          sub: segTimes.map(([st, e]) => ({ start: st, end: e })),
        });
      }
    });

    // Task 区间：start 用播报词位置；end 用下一个 Task 的播报词位置；最后一个 Task 延伸到音频物理时长
    const taskStartOut = b ? b.t0 : taskStart;
    const taskEndOut = bNext ? bNext.t0 : (audioDuration ?? (asrSents.length ? asrSents[asrSents.length - 1].end : taskEnd));
    result.tasks.push({
      id: task.id,
      title: task.title || "",
      start: taskStartOut,
      end: taskEndOut,
      lines,
    });
    const ok = lines.filter((l) => l.match === "exact" || l.match === "fuzzy").length;
    console.log(`  对齐 ${ok} 句 / 模糊 ${fuzzyCount} / 未对齐 ${missCount} | Task 区间 [${(taskStartOut ?? 0).toFixed(1)}, ${(taskEndOut ?? 0).toFixed(1)}]s`);
  }

  // ---- 4. 写回集成文件 ----
  const outPath = path.resolve(outArg || path.join(ROOT, "data", `${result.id}_aligned.json`));
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`\n========== 汇总 ==========`);
  console.log(`完全匹配: ${okCount} | 模糊(需复核): ${fuzzyCount} | 未对齐: ${missCount}`);
  console.log(`已写回集成文件: ${outPath}`);
  console.log("下一步: node scripts/split-audio.js \"" + outPath.replace(/\\/g, "/") + "\"（按 Task 边界切 mp3）");
}

main().catch((e) => {
  console.error("❌ " + (e && e.message ? e.message : e));
  process.exit(1);
});
