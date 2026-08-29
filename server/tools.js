/**
 * 试卷提取工具链 API（教师端 · 内置工具）
 *
 * 三个工具对应三个脚本，全部后台任务化（转写可能 20 分钟，不能阻塞 HTTP）：
 *   align    → scripts/audio-align.js   音频分句 + 真实文本对齐 → 集成文件
 *   split    → scripts/split-audio.js   按集成文件 Task 边界切 mp3
 *   extract  → ai-extract/index.js      OCR 文本 + 集成文件 → 题库 JSON
 *
 * 任务模型：POST 启动返回 taskId；GET /tasks/:id 轮询 {status, log, result}。
 * 任务日志落 data/.tools-tasks/<id>.log，进程退出后日志仍可查。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const express = require("express");
const multer = require("multer");

const ROOT = path.join(__dirname, "..");
const UPLOAD_DIR = path.join(ROOT, "data", ".tools-upload");
const TASK_DIR = path.join(ROOT, "data", ".tools-tasks");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TASK_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(6).toString("hex") + "_" + file.originalname.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_")),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ---- 任务管理（内存态 + 日志文件；服务器重启后旧任务日志仍在，但状态回到 unknown） ----
const TASKS = new Map();

function relOf(abs) {
  return path.relative(ROOT, abs).replace(/\\/g, "/");
}

function runTask(kind, script, args, env = {}) {
  const id = crypto.randomBytes(4).toString("hex");
  const logPath = path.join(TASK_DIR, id + ".log");
  const task = { id, kind, script: relOf(script), args: args.join(" "), status: "running", logPath, result: null, startedAt: new Date().toISOString() };
  TASKS.set(id, task);

  const log = (s) => fs.appendFileSync(logPath, s);
  log(`$ node ${relOf(script)} ${args.join(" ")}\n\n`);

  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  child.stdout.on("data", (d) => log(d.toString()));
  child.stderr.on("data", (d) => log(d.toString()));
  child.on("error", (e) => {
    log("\n[进程错误] " + e.message + "\n");
    task.status = "failed";
  });
  child.on("close", (code) => {
    log("\n[退出码 " + code + "]\n");
    task.status = code === 0 ? "done" : "failed";
  });
  return task;
}

function createToolsRouter() {
  const r = express.Router();

  // 上传文件 → 返回可用的相对路径（三个工具共用）
  r.post("/tools/upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: "未收到文件（字段名 file）" });
    res.json({ ok: true, path: relOf(req.file.path), size: req.file.size, name: req.file.originalname });
  });

  // 任务列表
  r.get("/tools/tasks", (req, res) => {
    res.json({ ok: true, tasks: [...TASKS.values()].map(({ logPath, ...t }) => t) });
  });

  // 任务状态 + 日志尾部（limit 行）
  r.get("/tools/tasks/:id", (req, res) => {
    const t = TASKS.get(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "任务不存在（服务器重启后任务丢失，日志文件仍在 data/.tools-tasks/）" });
    let log = "";
    try {
      log = fs.readFileSync(t.logPath, "utf8");
    } catch (_) {}
    const lines = log.split("\n");
    const tail = lines.slice(-Math.max(0, lines.length - (Number(req.query.lines) || 200))).join("\n");
    res.json({ ok: true, task: { id: t.id, kind: t.kind, status: t.status, result: t.result }, tail });
  });

  // 完整日志
  r.get("/tools/tasks/:id/log", (req, res) => {
    const t = TASKS.get(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "任务不存在" });
    try {
      res.type("text/plain; charset=utf-8").send(fs.readFileSync(t.logPath, "utf8"));
    } catch (_) {
      res.status(404).send("日志文件不存在");
    }
  });

  // ---- ⓪ API 连通性自测 ----
  r.post("/tools/test-api", (req, res) => {
    const { baseUrl, apiKey, model, chatModel } = req.body || {};
    if (!baseUrl || !apiKey) return res.status(400).json({ ok: false, error: "需要 baseUrl 与 apiKey" });
    const args = [path.join(ROOT, "scripts", "test-api.js"), "--base-url", baseUrl];
    if (model) args.push("--model", model);
    if (chatModel) args.push("--chat-model", chatModel);
    const env = {};
    if (apiKey) env.OPENAI_API_KEY = apiKey; // key 只走环境变量，不落日志
    const task = runTask("test-api", args[0], args.slice(1), env);
    res.json({ ok: true, task: { id: task.id } });
  });

  // ---- ① 音频对齐 ----
  r.post("/tools/align", (req, res) => {
    const { audio, json, skipAsr, asr, apiKey, baseUrl, model } = req.body || {};
    if (!audio || !json) return res.status(400).json({ ok: false, error: "需要 audio 与 json 的文件路径" });
    const args = [path.join(ROOT, "scripts", "audio-align.js"), path.join(ROOT, audio), path.join(ROOT, json)];
    const id = crypto.randomBytes(4).toString("hex");
    const out = path.join(ROOT, "data", `${path.basename(json, ".json").replace(/[^\w-]/g, "")}_aligned.json`);
    args.push("--out", out);
    if (skipAsr) args.push("--skip-asr");
    if (asr) args.push("--asr", asr);
    if (baseUrl) args.push("--base-url", baseUrl);
    if (model) args.push("--model", model);
    // API key 只走环境变量，不落到命令行/任务日志
    const env = {};
    if (apiKey) env.OPENAI_API_KEY = apiKey;
    const task = runTask("align", args[0], args.slice(1), env);
    res.json({ ok: true, task: { id: task.id }, out: relOf(out) });
  });

  // ---- ② 自动剪裁 ----
  r.post("/tools/split", (req, res) => {
    const { aligned, audio, prefix, padding, outDir } = req.body || {};
    if (!aligned) return res.status(400).json({ ok: false, error: "需要 aligned 集成文件路径" });
    const args = [path.join(ROOT, "scripts", "split-audio.js"), path.join(ROOT, aligned)];
    if (audio) args.push("--audio", path.join(ROOT, audio));
    if (prefix) args.push("--prefix", prefix);
    if (padding != null) args.push("--padding", String(padding));
    if (outDir) args.push("--out-dir", path.join(ROOT, outDir));
    const task = runTask("split", args[0], args.slice(1));
    res.json({ ok: true, task: { id: task.id } });
  });

  // ---- ③ AI 提取配对 ----
  r.post("/tools/extract", (req, res) => {
    const { ocr, meta, aligned, provider, apiKey, baseUrl, model, out } = req.body || {};
    if (!ocr) return res.status(400).json({ ok: false, error: "需要 ocr 题目文本文件路径" });
    const args = [path.join(ROOT, "ai-extract", "index.js"), path.join(ROOT, ocr)];
    if (meta) args.push("--meta", "@" + path.join(ROOT, meta));
    if (aligned) args.push("--aligned", path.join(ROOT, aligned));
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    if (out) args.push("--out", path.join(ROOT, out));
    const env = {};
    if (apiKey) env.AI_API_KEY = apiKey;
    if (baseUrl) env.AI_BASE_URL = baseUrl;
    const task = runTask("extract", args[0], args.slice(1), env);
    res.json({ ok: true, task: { id: task.id } });
  });

  return r;
}

module.exports = { createToolsRouter, TASKS };
