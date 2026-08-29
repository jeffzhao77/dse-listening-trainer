/**
 * split-audio —— 按 Task 边界自动剪裁完整录音（工具链第 2 步，ffmpeg 方案）
 *
 * 输入集成文件（audio-align 产出）或题库 JSON：
 *   { tasks: [{ id, start, end }] }  —— start/end 为音频秒数
 *
 * 用法:
 *   node scripts/split-audio.js <aligned.json> [--audio 完整录音.mp3] [--out-dir 输出目录] [--prefix 卷id] [--padding 前后补秒]
 *
 * 默认输出到 MT56-PartA-学生完整包/audio/<prefix>_taskN.mp3，与题库 JSON 的 audio 字段命名一致。
 * ffmpeg 用 -ss 放 -i 之后做输出端精确 seek，保证切点不偏移（教学音频要求精确）。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "MT56-PartA-学生完整包", "audio");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const file = args[0];
const audioArg = opt("--audio");
const outDir = opt("--out-dir") || DEFAULT_OUT;
const prefix = opt("--prefix");
const padding = parseFloat(opt("--padding", "0.5")) || 0;

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

// ---- ffmpeg 探测（PATH + npm 包 @ffmpeg-installer/ffmpeg + winget 常见安装位置） ----
function findFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return "ffmpeg";
  } catch (_) {}
  try {
    const p = require("@ffmpeg-installer/ffmpeg").path;
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  const candidates = [];
  const local = process.env.LOCALAPPDATA || "";
  const wingetDir = path.join(local, "Microsoft", "WinGet", "Packages");
  try {
    for (const d of fs.readdirSync(wingetDir)) {
      if (d.toLowerCase().includes("ffmpeg")) {
        const root = path.join(wingetDir, d);
        const walk = (dir) => {
          for (const e of fs.readdirSync(dir)) {
            const p = path.join(dir, e);
            if (fs.statSync(p).isDirectory()) {
              if (e === "bin" && fs.existsSync(path.join(p, "ffmpeg.exe"))) candidates.push(path.join(p, "ffmpeg.exe"));
              walk(p);
            }
          }
        };
        walk(root);
      }
    }
  } catch (_) {}
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function main() {
  if (!file) {
    console.error("用法: node scripts/split-audio.js <aligned.json> [--audio 完整录音.mp3] [--out-dir 目录] [--prefix 卷id] [--padding 秒]");
    process.exit(1);
  }
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) fail("未找到 ffmpeg。请先安装: winget install --id Gyan.FFmpeg -e");

  const abs = path.resolve(file);
  const DATA = JSON.parse(fs.readFileSync(abs, "utf8"));
  const tasks = (DATA.tasks || []).filter((t) => typeof t.start === "number" && typeof t.end === "number");
  if (!tasks.length) fail("集成文件里没有带 start/end 的 Task 边界，请先跑 audio-align 或人工补边界");

  // 完整录音：优先 --audio，否则用集成文件里记录的 audio 字段（相对当前文件目录）
  let audioAbs = audioArg ? path.resolve(audioArg) : null;
  if (!audioAbs && DATA.audio) {
    const p = path.resolve(path.dirname(abs), DATA.audio);
    if (fs.existsSync(p)) audioAbs = p;
    else {
      const p2 = path.resolve(ROOT, DATA.audio);
      if (fs.existsSync(p2)) audioAbs = p2;
    }
  }
  if (!audioAbs || !fs.existsSync(audioAbs)) fail("找不到完整录音（用 --audio 指定）: " + audioAbs);
  if (!tasks.length) fail("集成文件没有可用边界");

  const pfx = prefix || DATA.id || "paper";
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`完整录音: ${audioAbs}`);
  console.log(`输出目录: ${outDir}`);
  console.log(`命名: ${pfx}_taskN.mp3 | padding: ±${padding}s | ffmpeg: ${ffmpeg}\n`);

  const results = [];
  for (const t of tasks) {
    const start = Math.max(0, t.start - padding);
    const end = t.end + padding;
    const out = path.join(outDir, `${pfx}_task${t.id}.mp3`);
    console.log(`▶ Task ${t.id} [${start.toFixed(2)} → ${end.toFixed(2)}]s → ${path.basename(out)}`);
    try {
      execFileSync(
        ffmpeg,
        ["-y", "-i", audioAbs, "-ss", String(start), "-to", String(end), "-c:a", "libmp3lame", "-b:a", "192k", out],
        { stdio: "ignore", timeout: 10 * 60 * 1000 }
      );
      const size = fs.statSync(out).size;
      results.push({ id: t.id, start, end, file: out, size });
      console.log(`  ✓ ${(size / 1024 / 1024).toFixed(1)} MB`);
    } catch (e) {
      console.error(`  ❌ 剪切失败: ${String(e.message).split("\n")[0]}`);
    }
  }

  console.log(`\n========== 完成 ==========`);
  console.log(`切出 ${results.length}/${tasks.length} 段:`);
  for (const r of results) console.log(`  - ${path.relative(ROOT, r.file).replace(/\\/g, "/")}  [${r.start.toFixed(1)}, ${r.end.toFixed(1)}]s`);
  console.log("\n下一步: 把题库 JSON 的 task.audio 指向这些文件，再 validate → import");
}

main();
