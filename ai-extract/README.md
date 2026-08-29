# ai-extract — 独立 AI 提取配对服务（工具链第 3 步）

把「扫描卷 OCR 出的题目文本」+「audio-align 产出的参考时间轴」变成可导入的题库 JSON。

## 快速上手（mock，不需要 key）

```bash
node ai-extract/index.js data/.ocr_sample.txt --provider mock --dry-run
```

## 接真实 LLM（OpenAI 兼容）

```bash
set AI_PROVIDER=openai
set AI_BASE_URL=https://api.deepseek.com/v1    # 或 OpenAI / 通义 compatible-mode
set AI_API_KEY=sk-xxxx
set AI_MODEL=deepseek-chat

node ai-extract/index.js data/2023A_ocr.txt --meta "{\"id\":\"2023A\",\"year\":2023,\"title\":\"2023 Part A\",\"totalMarks\":42,\"situation\":\"...\",\"taskCount\":4}" --aligned data/2023A_aligned.json
```

## Provider 接口（可扩展本地模型）

`provider.js` 定义统一接口 `async chat(messages) -> string`，providers/ 下每个文件是一个实现：

- `mock.js` —— 内置启发式，不联网
- `openai.js` —— OpenAI 兼容 /chat/completions（DeepSeek / OpenAI / 通义均可）
- 本地模型：写一个 `providers/local.js`，内部调 ollama / llama.cpp 的 HTTP 接口即可，无需改主流程

环境变量：`AI_PROVIDER` / `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`。

## 参数

```
node ai-extract/index.js <题目文本.txt> [--out xxx_partA.json]
  [--meta '{...}'] [--aligned aligned.json]
  [--provider mock|openai] [--base-url URL] [--api-key KEY] [--model MODEL]
  [--dry-run]
```

输出走 `node scripts/validate-paper.js` → `node scripts/import-paper.js` 进入系统。

## 设计原则

- AI 只做「文字理解 + 语义配对」，不碰判分、不碰精听逻辑（判分仍在 shared/grade.js）
- 独立于 server 进程，可单独部署；provider 可替换，key 不进代码
- 音频时间轴来自本地 Whisper + 真实文本对齐（audio-align），AI 只消费不生成
