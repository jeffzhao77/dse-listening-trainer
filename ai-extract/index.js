/**
 * ai-extract —— 独立 AI 提取配对服务（工具链第 3 步，接口抽象，可接外部 LLM 或本地模型）
 *
 * 输入：扫描卷 OCR 出的题目文本（txt）+ 元信息 meta + 可选参考时间轴（audio-align 产出的 aligned.json）
 * 输出：可导入的题库 JSON（<id>_partA.json），后续走 validate-paper → import-paper
 *
 * 用法:
 *   node ai-extract/index.js <题目文本.txt> [--out xxx_partA.json]
 *     [--meta '{"id":"2023A","year":2023,"title":"...","totalMarks":42,"situation":"...","taskCount":4}']
 *     [--aligned aligned.json]
 *     [--provider mock|openai] [--base-url URL] [--api-key KEY] [--model MODEL]
 *     [--dry-run]  只打印 AI 输出，不写文件
 *
 * 环境变量: AI_PROVIDER / AI_BASE_URL / AI_API_KEY / AI_MODEL
 */
const fs = require("fs");
const path = require("path");
const { createProvider } = require("./provider");
const { buildMessages } = require("./prompt");

const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const textFile = args[0];
const outArg = opt("--out");
const metaArg = opt("--meta");
const alignedArg = opt("--aligned");
const dryRun = args.includes("--dry-run");

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

function extractJson(text) {
  const m = String(text).match(/```json\s*([\s\S]*?)```/);
  const raw = m ? m[1] : String(text).replace(/^```\w*\s*/, "").replace(/```\s*$/, "");
  return JSON.parse(raw);
}

async function main() {
  if (!textFile) {
    console.error("用法: node ai-extract/index.js <题目文本.txt> [--out out.json] [--meta '{...}'] [--aligned aligned.json] [--provider mock|openai] [--api-key KEY] [--model MODEL] [--dry-run]");
    process.exit(1);
  }
  const textAbs = path.resolve(textFile);
  if (!fs.existsSync(textAbs)) fail("题目文本不存在: " + textAbs);
  const text = fs.readFileSync(textAbs, "utf8");

  let meta = {};
  if (metaArg) {
    try {
      // 支持 --meta '{"..."}' 直接传 JSON，或 --meta @file.json 从文件读
      meta = metaArg.startsWith("@")
        ? JSON.parse(fs.readFileSync(path.resolve(metaArg.slice(1)), "utf8"))
        : JSON.parse(metaArg);
    } catch (e) {
      fail("--meta 不是合法 JSON: " + e.message);
    }
  }
  if (!meta.id) {
    const base = path.basename(textAbs, path.extname(textAbs));
    meta.id = base.replace(/_ocr$/, "");
  }

  let aligned = null;
  if (alignedArg) {
    const p = path.resolve(alignedArg);
    if (!fs.existsSync(p)) fail("参考时间轴不存在: " + p);
    aligned = JSON.parse(fs.readFileSync(p, "utf8"));
    console.log("已加载参考时间轴: " + p + "（Task 数: " + (aligned.tasks || []).length + "）");
  }

  const provider = createProvider({
    kind: opt("--provider"),
    baseURL: opt("--base-url"),
    apiKey: opt("--api-key"),
    model: opt("--model"),
  });
  console.log(`Provider: ${provider.name}`);
  console.log(`题目文本: ${textAbs}（${text.length} 字符）`);
  console.log("调用 AI 提取并配对题目…（可能需 1-3 分钟）");

  const messages = buildMessages({ meta, text, aligned });
  const out = await provider.chat(messages, { maxTokens: 16384 });

  let DATA;
  try {
    DATA = extractJson(out);
  } catch (e) {
    console.error("⚠️ AI 输出不是合法 JSON:");
    console.error(out.slice(0, 1500));
    fail("无法解析 AI 输出（可重试或改用更强模型）");
  }
  if (!Array.isArray(DATA.tasks)) fail("AI 输出缺少 tasks 数组，结构不符合要求");

  const qCount = DATA.tasks.reduce((n, t) => n + (t.blocks || []).length, 0);
  console.log(`\n✅ 提取完成：${DATA.tasks.length} 个 Task，约 ${qCount} 个 blocks`);

  if (dryRun) {
    console.log("\n" + JSON.stringify(DATA, null, 2));
    return;
  }

  const outPath = path.resolve(outArg || path.join(ROOT, "MT56-PartA-学生完整包", "data", `${meta.id}_partA.json`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(DATA, null, 2), "utf8");
  console.log("已写回: " + outPath);
  console.log("下一步: node scripts/validate-paper.js \"" + outPath.replace(/\\/g, "/") + "\"");
}

main().catch((e) => {
  console.error("❌ " + (e && e.message ? e.message : e));
  process.exit(1);
});
