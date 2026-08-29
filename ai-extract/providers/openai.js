/**
 * openai provider —— OpenAI 兼容 /chat/completions
 * 适配 DeepSeek（https://api.deepseek.com/v1）、OpenAI（https://api.openai.com/v1）、
 * 通义 compatible-mode（https://dashscope.aliyuncs.com/compatible-mode/v1）等。
 */
module.exports = (cfg) => ({
  name: "openai",
  async chat(messages, opts = {}) {
    const baseURL = (cfg.baseURL || process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKey = cfg.apiKey || process.env.AI_API_KEY;
    if (!apiKey) throw new Error("缺少 AI_API_KEY（环境变量或 --api-key 传入）");
    const model = cfg.model || process.env.AI_MODEL || "gpt-4o-mini";
    const maxTokens = opts.maxTokens || 8192;

    const resp = await fetch(baseURL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error("AI API " + resp.status + ": " + body.slice(0, 300));
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || "";
    if (!content) throw new Error("AI 返回空内容（可能是 max_tokens 太小）");
    return content;
  },
});
