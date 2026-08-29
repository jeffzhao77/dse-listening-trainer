/**
 * mock provider —— 内置启发式占位
 * 不联网、不需要 key。按「编号行」粗切题目，产出可导入的 fill 骨架 JSON。
 * 真实语义配对请用 openai provider（见 README）。
 */
function parseQuestions(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const ln of lines) {
    const m = ln.match(/^(\d{1,2})[.)、]\s*(.*)$/);
    if (m) {
      out.push({ no: Number(m[1]), label: m[2] || `(${m[1]})` });
    }
  }
  return out;
}

module.exports = () => ({
  name: "mock",
  async chat(messages) {
    // 从最后一条 user 消息里提取约定格式的字段
    const last = messages[messages.length - 1]?.content || "";
    const metaMatch = last.match(/--META--\s*(\{[\s\S]*?\})\s*--TEXT--/);
    const textMatch = last.match(/--TEXT--\s*([\s\S]*)$/);
    const meta = metaMatch ? JSON.parse(metaMatch[1]) : { id: "paper", title: "未命名", totalMarks: 0 };
    const text = textMatch ? textMatch[1] : last;

    const qs = parseQuestions(text);
    const tasks = [];
    const taskCount = meta.taskCount || 1;
    for (let t = 1; t <= taskCount; t++) {
      const start = Math.floor(((t - 1) * qs.length) / taskCount);
      const end = Math.floor((t * qs.length) / taskCount);
      const blocks = qs.slice(start, end).map((q) => ({
        no: q.no,
        type: "fill",
        label: q.label,
        answer: [],
        signal: "",
        cloze: "",
        ts: { signal: [0, 0], answer: [0, 0] },
      }));
      tasks.push({
        id: t,
        title: `Task ${t}`,
        marks: blocks.length,
        audio: `audio/${meta.id}_task${t}.mp3`,
        instructions: "待补答题指引",
        tapescript: [],
        blocks,
      });
    }

    const json = {
      id: meta.id,
      paper: "Paper 3 (Listening & Integrated Skills) — Part A",
      title: meta.title || `${meta.id} Part A`,
      perTaskAudio: true,
      totalMarks: qs.length,
      situation: meta.situation || "待补情境",
      speakers: { A: "Announcer" },
      tasks,
    };
    return "```json\n" + JSON.stringify(json, null, 2) + "\n```";
  },
});
