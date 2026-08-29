/**
 * 提示词构造 —— 把 OCR 题目文本 + meta + 集成文件（aligned.json）组装成给 AI 的消息
 */

// 与 new-paper.js 骨架一致的输出结构示例
const STRUCTURE_EXAMPLE = `{
  "id": "2023A", "paper": "Paper 3 (Listening & Integrated Skills) — Part A",
  "title": "标题", "perTaskAudio": true, "totalMarks": 42,
  "situation": "整卷情境一句话",
  "speakers": { "A": "Announcer" },
  "tasks": [{
    "id": 1, "title": "Task 1 标题", "marks": 11,
    "audio": "audio/2023A_task1.mp3",
    "instructions": "答题指引原文",
    "tapescript": [{ "sp": "Ch", "t": "说话人逐字稿，按说话人分段" }],
    "blocks": [
      { "type": "heading", "text": "分组标题" },
      { "type": "fill", "no": 1, "label": "(1) 题干",
        "answer": ["参考答案，可接受变体用 / 分隔"],
        "signal": "答案出现前的提示句", "cloze": "完整答案句",
        "ts": { "signal": [10.0, 14.0], "answer": [14.0, 19.0] } },
      { "type": "mc", "no": 2, "label": "...", "options": ["A","B","C","D"], "answer": "A" },
      { "type": "tick", "no": 3, "label": "...", "options": [...], "answer": ["A","C"] },
      { "type": "map", "no": 4, "label": "...", "img": "assets/2023A/map.png", "options": [...], "answer": "B" },
      { "type": "steporder", "label": "...", "items": [ { "no": 5, "img": "...", "answer": "2", "signal": "...", "cloze": "..." } ] },
      { "type": "table", "rows": [ [ { "static": "..." }, { "fill": { "no": 6, ... } } ] ] }
    ]
  }]
}`;

function buildMessages({ meta, text, aligned }) {
  const system = [
    "你是 DSE 香港中学文凭考试 Paper 3 Part A 听力试卷转换助手。",
    "任务：把用户提供的「扫描试卷文字内容」转成系统题库 JSON。",
    "要求：",
    "1. 只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块之外的内容（JSON 放在 ```json ... ``` 内）。",
    "2. 结构严格遵循示例；题号从 1 连续；每道题必须有 no/type/label/answer。",
    "3. answer 字段：试卷上能确定的答案就填（用 / 分隔可接受变体，可选项用 ( )）；无法确定的留空数组 []。",
    "4. signal（答案出现前的提示句）、cloze（完整答案句）尽量从 tapescript 里摘录；摘不到就留空字符串。",
    "5. ts 只在提供了「参考时间轴」时填写（从参考时间轴中对应句子取起止秒），否则填 [0,0]。",
    "6. 地图/步骤图等图片题：img 填 assets/<id>/ 下的文件名，把图片内容描述进 label。",
    "7. tapescript 按说话人分段（sp 用 speakers 的键），逐字稿与参考时间轴的文本一致则直接用。",
  ].join("\n");

  const user = [
    "--META--",
    JSON.stringify(meta),
    "--TEXT--",
    "以下是扫描试卷 OCR 出的文字内容（可能有识别错误、排版错乱，请按语义整理）：",
    "```",
    text,
    "```",
  ].join("\n") +
    (aligned
      ? "\n\n--REFERENCE--\n以下是从录音转写并对齐真实文本得到的参考时间轴（句子→起止秒），用于确定 ts 和核对 signal/cloze：\n```\n" +
        JSON.stringify(aligned) +
        "\n```"
      : "");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

module.exports = { buildMessages, STRUCTURE_EXAMPLE };
