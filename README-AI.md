# DSE Listening Trainer — 技术文档（AI / 开发者版）

> 面向接手开发的 AI 与工程师。结构：架构 → 模块 → 数据模型 → API → 工具链 → 里程碑定位 → 已知限制 → 继续开发指引。

## 1. 项目定位

香港中学文凭考试（DSE）Paper 3 Part A 听力训练系统：学生在线做题 + 错题精听，教师端成绩看板/导出，外加一套「扫描卷 + 录音 → 可精听试卷」的自动化提取工具链。程序与题库分离，判分引擎前后端同源（设计原则见《项目设计说明书》）。

## 2. 技术栈与目录

- Node.js（≥18）+ Express 4 + SQLite（`node:sqlite`，无 ORM）；前端为原生 HTML/JS（无构建步骤）
- 语音识别：阿里云百炼 paraformer-v2（异步文件转写）；OSS 自动上传；本地 whisper.cpp 备选
- OCR：qwen-vl-ocr（多模态，主要）/ tesseract.js（备选）；PDF 渲染 pdfjs-dist + @napi-rs/canvas
- 判分：`shared/grade.js`（fill 变体匹配 `//` `/` `()` 语法，兼容 HKEAA marking scheme 答案格式）

```
server/          Express 后端（index/db/reports/export/tools）
apps/student/    exam.html（做题/精听，支持多卷切换）+ login.html
apps/teacher/    dashboard.html（成绩看板）+ tools.html（提取工具页）
shared/grade.js  判分引擎（collectQuestions / gradeQuestion / studentAnswerPayload）
scripts/         工具链 CLI（audio-align / split-audio / fill-ts / oss / test-api / validate / import / new-paper / seed-demo / auto-ts / whisper-common）
ai-extract/      独立 AI 服务（index.js OCR 提取配对 / ocr.js PDF识别 / provider 抽象）
MT56-PartA-学生完整包/   demo 卷（自包含，双击 partA.html 可玩）
2021HKDSE-新卷/   2021 真题卷（自包含：partA.html + 56题题库 + 4段音频 + source 中间产物）
data/            运行时（dse.sqlite、.oss-config.json、工具缓存）
```

## 3. 数据模型（data/dse.sqlite，见 server/schema.sql）

8 张表：`users / classes / class_members / papers / questions / attempts / answers / analytics_events`（+ `answer_ai_analyses` 预留）。
- 题目正文**不在库**：papers.content_json_path 指向题库 JSON（权威），questions 表只是索引（判分时仍读 JSON）
- 作答记录是唯一事实来源：attempts（整卷）+ answers（逐题，含耗时/播放/精听次数）

## 4. API 一览（server/index.js, reports.js, export.js, tools.js）

```
auth:     POST /api/auth/login|logout   GET /api/auth/me
attempts: POST /api/attempts（建/取，paperCode）  GET /api/attempts/:id  POST /api/attempts/:id/answers（草稿）  POST /api/attempts/:id/submit（权威判分）
reports:  GET /api/classes  /api/classes/:id/students  /api/reports/class/:id  /api/reports/attempt/:id  /api/reports/question/:no（仅 teacher）
export:   GET /api/export/students.csv  answers.csv  answers.json（?classId=，teacher，UTF-8 BOM）
tools:    POST /api/tools/upload|align|split|extract|test-api   GET /api/tools/tasks(/:id)（后台任务，日志在 data/.tools-tasks/）
static:   /papers/mt56/  /papers/2021HKDSE/（登录后静态题库）
```

鉴权：cookie session（dse_session，内存 Map）；`requireLogin` 注意：挂 /api 前缀后 req.path 被剥离，未登录 /api 子路径返回 302 而非 401（已知小坑）。

## 5. 试卷提取工具链（scripts/，核心资产）

```
完整录音 + 题库JSON(含tapescript) ── audio-align ──> aligned.json（句子↔时间↔说话人 + Task边界）
    │ --asr dashscope（paraformer，自动传 OSS）｜--asr local（whisper.cpp）｜--asr cloud（OpenAI兼容）
    │ --skip-asr 复用 data/.audio-align-tmp/full.json 缓存（省额度/时间）
aligned.json ── split-audio ──> audio/<卷id>_taskN.mp3（播报词边界，误差<0.1s）
aligned.json + 题库JSON(signal/cloze) ── fill-ts ──> 每题 ts.signal/ts.answer（相对 Task 音频秒数）
扫描PDF ── ai-extract/ocr.js（qwen-vl-ocr）──> 题目文本；ai-extract/index.js（LLM）──> 题库JSON骨架
```

- `audio-align` 对齐算法：**DP 全局序列对齐**（Needleman-Wunsch，句子级相似度），替代早期贪心游标（后者在短句密集对话会连环漏）；MT56 对齐率 86%，Task 2（电话对话）从 16%→84%
- `whisper-common.js` 转写 provider 抽象：`transcribe(audioRef, outBase, {provider})`，统一输出 `{transcription:[{text, offsets:{from,to}, words[]}]}`（秒）
- DashScope 要点：异步任务 `POST /api/v1/services/audio/asr/transcription`（X-DashScope-Async: enable，JSON body 含 file_urls 公网 URL）→ 轮询 `/api/v1/tasks/{id}` → 下载 transcription_url；**不收本地文件**（oss.js 自动上传）
- 阿里云百炼 CLI `bl` 已装可查额度（`bl usage free`）

## 6. 里程碑定位（对照《项目设计说明书》M1-M6）

| 阶段 | 内容 | 状态 | 说明 |
|---|---|---|---|
| **M1 骨架** | 登录/角色/班级、学生端做题+前端判分 | ✅ 完成 | mt56 卷可跑通 |
| **M2 作答持久化** | attempts/answers 落库、服务器权威判分、断线续答 | ✅ 完成 | answers_snapshot_json 快照续答 |
| **M3 教师端** | 班级/学生看板、逐题 diff、错题本、导出 CSV/JSON | ✅ 完成 | dashboard.html + reports/export |
| **M4 题库导入** | 真题导入 + 时间戳校准 | ✅ 超额完成 | new-paper/validate/import + 提取工具链（对齐/剪裁/题级ts/OCR/AI配对）+ 2021 真题全流程实测 + 学生端多卷选择 |
| **M5 预留与分析** | analytics 接口占位、raw events 导出、内网部署+版权加固 | 🔶 部分 | `analytics_events` 表已落库（attempt_started/answers_saved/attempt_submitted）；**未做**：/api/analytics/* 占位 API、raw events 导出、版权访问控制/防盗链 |
| **M6 AI 诊断** | AI 错因/薄弱点分析 | ❌ 未开始 | 数据已备好（answers 逐题耗时/精听次数 + analytics_events），只差消费逻辑 |

## 7. 已知限制（接手者须知）

- 学生端选卷已支持（exam.html 右上角，localStorage 记忆），但试卷列表写死于 `PAPERS` 常量（加卷需改代码）；未做"按班级指定卷"
- 前端判分仍为内联复刻 shared/grade.js（设计原则"判分同源"未完全落地，存在两端漂移风险）
- 对齐剩余 ~14% 句子 missing（带 near 建议供人工补）；ts 为句子级区间（词级 refine 未做）
- 教师端 tools.html 的 API 链路已验证，浏览器交互未完整实测
- `requireLogin` 未登录 /api 子路径返回 302 的兼容性问题（见 §4）
- 语音识别依赖阿里云百炼 key 与 OSS 凭证（配置见 data/.oss-config.json，勿提交仓库）

## 8. 继续开发指引

- 配置/排查语音识别：调项目 skill `/dse-voice-recognition-setup`（含故障排查表）
- 加一套新卷：new-paper 骨架 → 填 JSON（signal/cloze）→ audio-align → split → fill-ts → validate → import → 在 exam.html `PAPERS` 常量登记
- 测试入口：`npm start`（localhost:3000，student/student123，teacher/teacher123）；demo 页面 8011（见 README.md）
- 后续方向（P0→P3）：学生端按班级指定卷 / 工具页补完 → 判分同源 / ts 词级 refine / 对齐优化 → M5 analytics API + raw events → M6 AI 诊断 → qwen3-asr 增强 / 版权加固
