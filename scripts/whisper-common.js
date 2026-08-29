/**
 * whisper 调用与文本对齐公共模块
 *
 * 从 auto-ts.js 抽取的可复用部分，供 audio-align / split-audio / ai-extract 等工具共用：
 *   - norm / tokens：文本归一化与分词
 *   - findBin / detectEngine / transcribe：whisper.cpp / openai-whisper 的探测与调用
 *   - expandWords：ASR 结果 → 带时间戳的词序列
 *   - alignRange：把目标句子的词序列在 ASR 词流里对齐，返回起止索引
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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

// ---- whisper 探测 ----
function detectEngine(bin, engine) {
  if (engine && engine !== "auto") return engine;
  try {
    const out = execFileSync(bin, ["--help"], { encoding: "utf8", timeout: 20000 });
    return /--output_format|--output_dir/.test(out) ? "openai" : "cpp";
  } catch (_) {
    return "cpp";
  }
}

function findBin(whisperBin) {
  if (whisperBin) return path.resolve(whisperBin);
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

// ---- whisper 调用 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * DashScope 异步文件转写（阿里云百炼语音识别）
 * 规范（官方文档）：POST /api/v1/services/audio/asr/transcription（X-DashScope-Async: enable）
 *   → 轮询 GET /api/v1/tasks/{task_id} → 下载 transcription_url JSON
 * 注意：阿里云语音转写只接受「公网可访问的音频 URL」（file_urls），本地文件需先传 OSS 拿 URL。
 * @param {string} audioRef 公网音频 URL（http/https 开头）；本地路径会提示先上传 OSS
 */
async function transcribeDashscope(audioRef, outBase, opts = {}) {
  const base = (opts.baseURL || process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com").replace(/\/+$/, "");
  const key = opts.apiKey || process.env.DASHSCOPE_API_KEY || process.env.AI_API_KEY;
  if (!key) throw new Error("DashScope 转写需要 DASHSCOPE_API_KEY（--api-key 或环境变量）");
  const model = opts.model || process.env.DASHSCOPE_ASR_MODEL || "paraformer-v2";
  const lang = opts.lang || "en";

  // 音频必须是公网 URL；本地路径 → 自动上传 OSS 拿签名 URL
  if (!/^https?:\/\//i.test(audioRef)) {
    try {
      const { uploadToOss } = require("./oss");
      console.log("  本地音频 → 自动上传 OSS…");
      audioRef = await uploadToOss(audioRef, {
        region: opts.ossRegion,
        bucket: opts.ossBucket,
        accessKeyId: opts.ossAk,
        accessKeySecret: opts.ossSk,
      });
      console.log("  OSS 签名 URL 已获取: " + audioRef.slice(0, 70) + "…");
    } catch (e) {
      throw new Error(
        "DashScope 语音转写需要公网音频 URL。自动上传 OSS 失败: " + (e.message || e) +
        "\n请配置 OSS（环境变量 OSS_BUCKET/OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET 或 data/.oss-config.json），或手动上传后把 URL 作为音频参数传入。"
      );
    }
  }

  // 1) 提交转写任务（JSON body + file_urls）
  const payload = {
    model,
    input: { file_urls: [audioRef] },
    parameters: { language_hints: [lang] },
  };
  if (opts.words !== false) payload.parameters.enable_words = true; // 词级时间戳（部分模型支持）
  const submitResp = await fetch(base + "/api/v1/services/audio/asr/transcription", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
    body: JSON.stringify(payload),
  });
  const submitBody = await submitResp.text();
  if (!submitResp.ok) throw new Error("提交转写任务失败 " + submitResp.status + ": " + submitBody.slice(0, 300));
  let taskId = null;
  try {
    taskId = JSON.parse(submitBody).output?.task_id;
  } catch (_) {}
  if (!taskId) throw new Error("提交成功但未返回 task_id: " + submitBody.slice(0, 300));
  console.log(`  DashScope 任务已提交: ${taskId}（模型 ${model}，轮询中…）`);

  // 2) 轮询任务状态（最长 30 分钟）
  let output = null;
  for (let i = 0; i < 600; i++) {
    await sleep(3000);
    const pr = await fetch(base + "/api/v1/tasks/" + taskId, { headers: { Authorization: "Bearer " + key } });
    const pj = await pr.json();
    const st = pj.output?.task_status;
    if (st === "SUCCEEDED") {
      output = pj.output;
      break;
    }
    if (st === "FAILED") throw new Error("转写任务失败: " + JSON.stringify(pj.output || {}).slice(0, 300));
    if (i % 20 === 19) console.log(`  …仍在处理（${Math.round((i + 1) * 3)}s）`);
  }
  if (!output) throw new Error("转写任务超时（30 分钟）");

  // 3) 下载识别结果
  const url = output.result?.transcription_url || output.results?.[0]?.transcription_url;
  if (!url) throw new Error("任务成功但无 transcription_url: " + JSON.stringify(output).slice(0, 300));
  const dr = await fetch(url);
  const dj = await dr.json();
  const sentences = (dj.transcripts || []).flatMap((t) => t.sentences || []);
  const segs = sentences.map((s) => ({
    text: s.text,
    offsets: { from: (s.begin_time || 0) / 1000, to: (s.end_time || 0) / 1000 },
    words: (s.words || []).map((w) => ({ word: w.text, offsets: { from: w.begin_time / 1000, to: w.end_time / 1000 } })),
  }));
  const out = { transcription: segs, model, source: "dashscope", duration: dj.duration };
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(outBase + ".json", JSON.stringify(out, null, 2), "utf8");
  console.log(`  DashScope 转写完成: ${segs.length} 句（${outBase}.json）`);
  return out;
}

/**
 * 云端转写（OpenAI Whisper API，/v1/audio/transcriptions，verbose_json + 词级时间戳）
 * 输出统一为本地一致的 { transcription: [{ text, offsets, words:[{word, offsets}] }] }（秒）
 */
async function transcribeCloud(audioAbs, outBase, opts = {}) {
  const base = (opts.baseURL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const key = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("云端转写需要 OPENAI_API_KEY（环境变量 AI_API_KEY/OPENAI_API_KEY 或 --api-key）");
  const model = opts.model || process.env.WHISPER_MODEL || "whisper-1";
  const buf = fs.readFileSync(audioAbs);
  const fd = new FormData();
  fd.append("file", new Blob([buf]), path.basename(audioAbs));
  fd.append("model", model);
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "word");
  if (opts.lang) fd.append("language", opts.lang);
  const resp = await fetch(base + "/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key },
    body: fd,
  });
  if (!resp.ok) throw new Error("云端转写 " + resp.status + ": " + (await resp.text()).slice(0, 500));
  const data = await resp.json();
  const segs = (data.segments || []).map((s) => ({
    text: s.text,
    offsets: { from: s.start, to: s.end },
    words: (s.words || []).map((w) => ({ word: w.word, offsets: { from: w.start, to: w.end } })),
  }));
  const out = { transcription: segs, duration: data.duration, model, source: "cloud" };
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(outBase + ".json", JSON.stringify(out, null, 2), "utf8");
  console.log(`  云端转写完成: ${(data.duration || 0).toFixed(1)}s 音频 → ${segs.length} 句（${outBase}.json）`);
  return out;
}

/**
 * 对音频执行一次转写（provider 可切换）。
 * @param {string} audioAbs 音频绝对路径
 * @param {string} outBase 输出前缀（不含扩展名），中间产物写 outBase.json
 * @param {object} opts { provider: 'local'|'cloud', whisperBin, model, engine, lang, apiKey, baseURL }
 *   provider 也可用环境变量 ASR_PROVIDER 指定；cloud 走 OpenAI Whisper API
 * @returns ASR 原始 JSON（transcription/segments 数组，offsets 已统一为秒）
 */
async function transcribe(audioAbs, outBase, opts = {}) {
  const provider = opts.provider || process.env.ASR_PROVIDER || "local";
  if (provider === "cloud") return transcribeCloud(audioAbs, outBase, opts);
  if (provider === "dashscope") return transcribeDashscope(audioAbs, outBase, opts);

  const engine = detectEngine(opts.whisperBin, opts.engine || "auto");
  const outDir = path.dirname(outBase);
  const lang = opts.lang || "en";
  if (engine === "cpp") {
    const m = opts.model || path.join(__dirname, "whisper", "ggml-small.bin");
    execFileSync(
      opts.whisperBin,
      ["-m", m, "-f", audioAbs, "-ojf", "-of", outBase, "-l", lang, "-sow"],
      { encoding: "utf8", timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }
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
  const m = opts.model || "small";
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(
    opts.whisperBin,
    [audioAbs, "--model", m, "--task", "transcribe", "--language", lang,
     "--word_timestamps", "True", "--output_format", "verbose_json", "--output_dir", outDir],
    { encoding: "utf8", timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }
  );
  const base = path.basename(audioAbs).replace(/\.[^.]+$/, "");
  return JSON.parse(fs.readFileSync(path.join(outDir, base + ".json"), "utf8"));
}

// ---- ASR 结果 → 词序列（优先 token 级，其次 word 级，最后 segment 级） ----
function expandWords(data) {
  const out = [];
  const segs = data.transcription || data.segments || [];
  for (const s of segs) {
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
    const text = String(s.text ?? "");
    const sStart = s.offsets?.from ?? s.start;
    const sEnd = s.offsets?.to ?? s.end;
    if (!text || typeof sStart !== "number" || typeof sEnd !== "number") continue;
    for (const tk of tokens(text)) out.push({ w: tk, t0: sStart, t1: sEnd });
  }
  return out;
}

// ---- 外部转写文件解析（引用成型转写软件：剪映/讯飞/飞书导出的 SRT/VTT/verbose_json）----
// SRT 时间戳 "HH:MM:SS,mmm"；VTT "HH:MM:SS.mmm"
function parseTsPart(part) {
  const m = String(part).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return NaN;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +("0." + m[4]);
}

/**
 * 解析 SRT 或 VTT 文本 → [{ text, offsets:{from,to} }]
 */
function parseSrtVtt(text) {
  const out = [];
  const blocks = String(text).split(/\r?\n\r?\n/);
  for (const b of blocks) {
    const m = b.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!m) continue;
    const from = parseTsPart(m[1]);
    const to = parseTsPart(m[2]);
    const textLines = b.split(/\r?\n/).slice(m[0] ? 1 : 0).filter((l) => !/^\d+$/.test(l.trim()) && !l.includes("WEBVTT") && !l.includes("NOTE")).join(" ").trim();
    // 跳过序号行：去掉块内第一行若为纯数字
    const cleaned = textLines.replace(/^\d+\s*/, "").trim();
    if (cleaned) out.push({ text: cleaned, offsets: { from, to } });
  }
  return out;
}

/**
 * 解析任意外部转写文件为统一 transcription 数组
 * 支持：.srt / .vtt / .json（verbose_json 风格：segments[] 或 transcription[]）
 */
function parseAsrFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    const j = JSON.parse(raw);
    const segs = j.transcription || j.segments || [];
    return segs.map((s) => ({
      text: s.text || "",
      offsets: { from: (s.offsets?.from ?? s.start ?? 0) / 1, to: (s.offsets?.to ?? s.end ?? 0) / 1 },
    }));
  }
  const sents = parseSrtVtt(raw);
  if (!sents.length) throw new Error("无法解析外部转写文件（支持 SRT/VTT/verbose_json）: " + filePath);
  return sents;
}

// ---- 对齐：目标句子词序列 → 在词流中定位起止 ----

// 词形容错匹配：解决 ASR 切词与文本不一致（"we'd better"→"webetter"、拼写小差异）
function matchWord(target, stream) {
  if (!target || !stream) return false;
  if (target === stream) return true;
  // 合并词/子串包含：target 或词流词是对方的子串（如 target "better" ∈ stream "webetter"）
  if (target.includes(stream) || stream.includes(target)) return true;
  // 编辑距离 ≤ 1：仅对较长词启用（短词如 at/an/it 编辑距离 1 会大量误匹配）
  const a = target.length, b = stream.length;
  if (a < 5 || b < 5) return false;
  if (Math.abs(a - b) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a && j < b) {
    if (target[i] === stream[j]) { i++; j++; }
    else {
      edits++;
      if (edits > 1) return false;
      if (a === b) { i++; j++; } // 替换
      else if (a > b) i++;        // 删除 target 字符
      else j++;                   // 插入
    }
  }
  return true;
}

/**
 * 精确连续匹配：从 fromIdx 起，target 词连续命中词流（词形容错）
 * @returns {{i0,i1,fuzzy,matched}|null}
 */
function alignRange(toks, words, fromIdx) {
  if (!toks.length) return null;
  let best = null;
  for (let i = fromIdx; i < words.length; i++) {
    if (!matchWord(toks[0], words[i].w)) continue;
    let j = 0, k = i;
    while (j < toks.length && k < words.length && matchWord(toks[j], words[k].w)) {
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

/**
 * 子序列匹配（允许跳词）：target 词依次在词流区间内贪心查找，
 * 解决 ASR 插入/漏词/切分不一致导致的连续匹配失败。
 * @param {string[]} toks 目标词
 * @param {Array} words 词流
 * @param {number} fromIdx 起始
 * @param {number} endIdx 区间末尾（含）
 * @returns {{i0,i1,fuzzy,matched,toks,span}|null} 命中率≥70% 且跨度可接受
 */
function alignSubseq(toks, words, fromIdx, endIdx) {
  if (!toks.length) return null;
  const end = endIdx ?? words.length - 1;
  let k = fromIdx;
  const hits = [];
  for (const tk of toks) {
    let found = -1;
    for (let i = k; i <= end; i++) {
      if (matchWord(tk, words[i].w)) { found = i; break; }
    }
    hits.push(found);
    if (found >= 0) k = found + 1;
  }
  const idx = hits.filter((i) => i >= 0);
  if (!idx.length) return null;
  const pct = idx.length / toks.length;
  const i0 = idx[0], i1 = idx[idx.length - 1];
  const span = i1 - i0 + 1;
  if (pct < 0.7) return null;          // 命中率不足
  if (span > toks.length * 3 + 6) return null; // 跨度太大（中间夹了过多无关内容）
  return { i0, i1, fuzzy: pct < 1, matched: idx.length, toks: toks.length, span };
}

// ---- 句子按标点拆子句（长段落便于对齐） ----
function splitSentences(text) {
  const parts = String(text || "")
    .replace(/([.?!])\s+/g, "$1\u0000")
    .split("\u0000")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [String(text || "").trim()];
}

module.exports = {
  norm,
  tokens,
  detectEngine,
  findBin,
  transcribe,
  parseAsrFile,
  expandWords,
  alignRange,
  alignSubseq,
  matchWord,
  splitSentences,
};
