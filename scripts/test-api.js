/**
 * test-api —— API 连通性自测（拿到中转站 key 后第一步就跑这个）
 *
 * 验证两件事：
 *   1. Whisper 转写可用：POST /v1/audio/transcriptions → 有句子 + 词级时间戳
 *   2. Chat 可用：POST /v1/chat/completions → 有回复
 *
 * 用法:
 *   node scripts/test-api.js --base-url https://xxx.com/v1 --api-key sk-xxx [--model whisper-1] [--chat-model gpt-4o-mini] [--audio 音频路径] [--lang en]
 *
 *   --api-key 也可用环境变量 OPENAI_API_KEY；默认音频取 MT56 task1 前 30 秒（省额度）。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { transcribe } = require("./whisper-common");

const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const baseURL = (opt("--base-url") || process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "").replace(/\/+$/, "");
const apiKey = opt("--api-key") || process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const model = opt("--model") || process.env.WHISPER_MODEL || "whisper-1";
const chatModel = opt("--chat-model") || process.env.AI_MODEL || "gpt-4o-mini";
const lang = opt("--lang", "en");
const audioArg = opt("--audio");

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

function findFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return "ffmpeg";
  } catch (_) {}
  try {
    const p = require("@ffmpeg-installer/ffmpeg").path;
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  return null;
}

async function testChat() {
  console.log(`\n▶ 测试对话 /chat/completions（模型 ${chatModel}）...`);
  const resp = await fetch(baseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: chatModel,
      messages: [{ role: "user", content: 'Reply with exactly: OK' }],
      max_tokens: 16,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.log("✗ 对话不可用: " + resp.status + " " + body.slice(0, 300));
    return false;
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "";
  console.log("✓ 对话可用，回复: " + content.slice(0, 60));
  return true;
}

async function main() {
  if (!baseURL || !apiKey) {
    console.error("用法: node scripts/test-api.js --base-url https://xxx.com/v1 --api-key sk-xxx [--model whisper-1] [--chat-model gpt-4o-mini] [--audio 音频]");
    console.error("      或设置环境变量 OPENAI_BASE_URL / OPENAI_API_KEY");
    process.exit(1);
  }
  console.log(`Base URL: ${baseURL}`);
  console.log(`转写模型: ${model} | 对话模型: ${chatModel}`);
  console.log(`语言: ${lang}`);

  // ---- 1. 转写测试（取 30 秒音频省额度） ----
  let audioAbs = audioArg ? path.resolve(audioArg) : path.join(ROOT, "MT56-PartA-学生完整包", "audio", "mt56_task1.mp3");
  if (!fs.existsSync(audioAbs)) fail("音频不存在: " + audioAbs);
  const tmp = path.join(ROOT, "data", ".api-test-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const sample = path.join(tmp, "sample30s.mp3");
  if (!fs.existsSync(sample)) {
    const ff = findFfmpeg();
    if (!ff) fail("未找到 ffmpeg");
    execFileSync(ff, ["-y", "-i", audioAbs, "-t", "30", "-c:a", "libmp3lame", "-b:a", "128k", sample], { stdio: "ignore", timeout: 120000 });
    console.log(`已切 30 秒测试音频: ${sample}`);
  }

  console.log(`\n▶ 测试转写 /audio/transcriptions（模型 ${model}）...`);
  try {
    const data = await transcribe(sample, path.join(tmp, "sample"), { provider: "cloud", apiKey, baseURL, model, lang });
    const segs = data.transcription || [];
    const wordCount = segs.reduce((n, s) => n + (s.words || []).length, 0);
    if (!segs.length) {
      console.log("✗ 转写返回空 transcription（检查模型名是否正确）");
      return;
    }
    const first = segs[0];
    const w0 = first.words?.[0];
    const tsOk = w0 && typeof w0.offsets?.from === "number";
    console.log(`✓ 转写可用: ${segs.length} 句, ${wordCount} 词`);
    console.log(`  首句: "${(first.text || "").slice(0, 70)}"`);
    console.log(`  词级时间戳: ${tsOk ? "✓ 正常（首词 " + w0.offsets.from.toFixed(2) + "s）" : "✗ 缺失（会影响对齐精度，请确认返回 verbose_json + word 时间戳）"}`);
  } catch (e) {
    console.log("✗ 转写失败: " + String(e.message || e).slice(0, 400));
  }

  // ---- 2. 对话测试 ----
  await testChat();

  console.log(`\n========== 自测结束 ==========`);
  console.log("两项都 ✓ 就可以正常使用工具链；有 ✗ 把输出发给客服确认。");
}

main().catch((e) => {
  console.error("❌ " + (e && e.message ? e.message : e));
  process.exit(1);
});
