/**
 * provider 抽象层 —— 独立 AI 服务的统一入口
 *
 * 现有 provider（ai-extract/providers/ 下，文件名即 kind）：
 *   mock   内置启发式占位，不联网、不需要 key，用于流程演示
 *   openai OpenAI 兼容 /chat/completions（DeepSeek、通义 compatible-mode 等均兼容）
 *
 * 环境变量（或 createProvider cfg 覆盖）：
 *   AI_PROVIDER=mock|openai
 *   AI_BASE_URL=https://api.deepseek.com/v1   （OpenAI 兼容地址）
 *   AI_API_KEY=sk-xxx
 *   AI_MODEL=deepseek-chat
 *
 * provider 统一接口：async chat(messages, opts?) -> string
 *   messages: [{ role: 'system'|'user'|'assistant', content: string }]
 */
const fs = require("fs");
const path = require("path");

function createProvider(cfg = {}) {
  const kind = cfg.kind || process.env.AI_PROVIDER || "mock";
  const file = path.join(__dirname, "providers", kind + ".js");
  if (!fs.existsSync(file)) {
    throw new Error("未知 provider: " + kind + "（可用: mock, openai）");
  }
  const make = require(file);
  const provider = make(cfg);
  return {
    name: kind,
    chat: (messages, opts) => provider.chat(messages, opts),
  };
}

module.exports = { createProvider };
