/**
 * pdf-extract（OCR）—— 扫描版 PDF → 题目文本（工具链第 0 步）
 *
 * 策略：
 *   1. 先试 pdfjs-dist 抽文字层（PDF 本身是文字版时零 OCR，又快又准）
 *   2. 文字层不足 → @napi-rs/canvas 渲染每页为 PNG → tesseract.js OCR（默认 eng）
 *
 * 用法:
 *   node ai-extract/ocr.js <扫描卷.pdf> [--out 输出.txt] [--lang eng|eng+chi_sim] [--scale 2]
 *
 * 注意：tesseract.js 首次运行会从 CDN 下载语言数据（可设 --lang-path 指定镜像/本地）。
 */
const fs = require("fs");
const path = require("path");

const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { Canvas } = require("@napi-rs/canvas");
const { createWorker } = require("tesseract.js");

const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const pdfFile = args[0];
const outArg = opt("--out");
const langArg = opt("--lang", "eng");
const scale = parseFloat(opt("--scale", "2")) || 2;
const langPathArg = opt("--lang-path");

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

// pdfjs 需要的 canvas 工厂（@napi-rs/canvas）
const canvasFactory = {
  create(width, height) {
    const canvas = new Canvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  },
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  },
  destroy() {},
};

async function pdfToText(pdfPath, { lang = "eng", langPath } = {}) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const task = pdfjsLib.getDocument({ data, useSystemFonts: true, canvasFactory });
  const pdf = await task.promise;
  console.log(`PDF: ${pdf.numPages} 页 | ${pdf.getPage ? "" : ""}`);

  const texts = [];
  const ocrPages = [];
  let textLayerChars = 0;

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    // 1) 文字层
    const tc = await page.getTextContent();
    const pageText = (tc.items || [])
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    textLayerChars += pageText.length;
    if (pageText.length > 40) {
      texts.push(`----- 第 ${p} 页（文字层）-----\n${pageText}`);
      console.log(`  第 ${p} 页: 文字层 ${pageText.length} 字符`);
    } else {
      // 2) 渲染 + OCR
      const viewport = page.getViewport({ scale });
      const canvas = new Canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport, canvasFactory }).promise;
      const png = canvas.toBuffer("image/png");
      ocrPages.push({ p, png });
      console.log(`  第 ${p} 页: 渲染 ${Math.ceil(viewport.width)}x${Math.ceil(viewport.height)} → OCR`);
    }
  }

  const mode = ocrPages.length === 0 ? "textlayer" : ocrPages.length < pdf.numPages ? "mixed" : "ocr";
  console.log(`文字层共 ${textLayerChars} 字符 → 模式: ${mode}`);

  if (ocrPages.length) {
    const worker = await createWorker(lang, 1, langPath ? { langPath } : {});
    for (const { p, png } of ocrPages) {
      const { data: r } = await worker.recognize(png);
      texts.push(`----- 第 ${p} 页（OCR）-----\n${r.text}`);
      console.log(`  第 ${p} 页 OCR 完成: ${(r.text || "").length} 字符`);
    }
    await worker.terminate();
  }

  return { text: texts.join("\n\n"), mode, pages: pdf.numPages };
}

async function main() {
  if (!pdfFile) {
    console.error("用法: node ai-extract/ocr.js <扫描卷.pdf> [--out 输出.txt] [--lang eng|eng+chi_sim] [--scale 2] [--lang-path URL]");
    process.exit(1);
  }
  const abs = path.resolve(pdfFile);
  if (!fs.existsSync(abs)) fail("PDF 不存在: " + abs);

  console.log(`OCR 语言: ${langArg} | 渲染倍率: ${scale}`);
  const { text, mode, pages } = await pdfToText(abs, { lang: langArg, langPath: langPathArg });

  if (!text.trim()) fail("未能从 PDF 提取任何文本（扫描质量差可调 --scale 3 或 --lang-path 换语言数据镜像）");

  const outPath = path.resolve(outArg || path.join(ROOT, "data", path.basename(abs, ".pdf") + "_ocr.txt"));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, "utf8");
  console.log(`\n✅ ${mode} 模式提取完成（${pages} 页），共 ${text.length} 字符`);
  console.log("已写回: " + outPath);
  console.log("下一步: node ai-extract/index.js \"" + outPath.replace(/\\/g, "/") + "\" --meta @xxx.json [--aligned xxx_aligned.json]");
}

main().catch((e) => {
  console.error("❌ " + (e && e.message ? e.message : e));
  process.exit(1);
});
