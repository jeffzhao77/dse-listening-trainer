# DSE Listening Trainer（DSE 听力训练系统）

一套给香港 DSE 考生用的**听力 Paper 3 Part A 训练系统**：学生在线做真题、交卷自动判分、错题逐句精听；老师能看全班成绩、导出报表；还能把「扫描版试卷 + 录音」自动变成可做题的电子卷。

## 一、怎么启动（1 分钟）

```bash
npm install      # 第一次才需要
npm start        # 启动后浏览器打开 http://localhost:3000
```

- 学生账号：`student` / `student123`
- 教师账号：`teacher` / `teacher123`

学生端右上角**可以切换试卷**（MT56 模拟卷 / 2021 DSE Part A）。

## 二、几个常用的地方

| 你想干什么 | 去哪 |
|---|---|
| 学生做题 | localhost:3000 用学生账号登录 |
| 看全班成绩、导出 CSV | 教师账号登录 →「教师端」 |
| 把新卷的 PDF+录音变成电子卷 | 教师端顶部「试卷工具」（或命令行，见下） |
| 不用服务器直接试某套卷 | 见「三、直接打开一套卷」 |

> 教师端当前展示的学生成绩是 **seed-demo 注入的模拟数据**（页面有提示），真实成绩来自学生在线作答。

## 三、直接打开一套卷（免服务器）

在项目文件夹打开终端运行：

```bash
node -e "const h=require('http'),f=require('fs'),p=require('path');const root=p.resolve('2021HKDSE-新卷');h.createServer((q,s)=>{const u=decodeURIComponent(q.url.split('?')[0]);const fp=p.join(root,u==='/'?'partA.html':u);f.readFile(fp,(e,d)=>{if(e){s.writeHead(404);s.end('404')}else{s.writeHead(200);s.end(d)}})}).listen(8011,()=>console.log('http://localhost:8011'))"
```

浏览器打开（把 `2021HKDSE-新卷` 换成 `MT56-PartA-学生完整包` 可看 demo 卷）：

```
http://localhost:8011/partA.html?data=data/2021HKDSE_P3A_partA.json
```

加 `&teacher=1` 进**老师校准模式**（手动微调每题的音频起止时间）。

## 四、加一套新卷（4 步）

1. 建骨架：`node scripts/new-paper.js`（按提示填）
2. 填内容：用编辑器打开生成的 JSON，把题目、答案、逐字稿填进去（照着 `2021HKDSE-新卷/data/2021HKDSE_P3A_partA.json` 的样子）
3. 自动标时间戳：`node scripts/audio-align.js 试卷.json 完整录音.mp3 --asr dashscope --api-key <你的百炼key>`（录音会自动上传云端识别；没 key 用本地也行，会慢很多）
4. 校验导入：`node scripts/validate-paper.js 试卷.json && node scripts/import-paper.js 试卷.json`

详细说明见 `docs-语音识别配置.md` 和 `提取工具链-使用说明.md`。

## 五、文件地图

```
server/          服务器（登录/判分/报表/导出）
apps/            学生端 + 教师端页面
shared/grade.js  判分规则（怎么算对）
scripts/         工具脚本（对齐/剪裁/标时间戳/导入…）
MT56-PartA-学生完整包/   demo 卷（双击 partA.html 就能玩）
2021HKDSE-新卷/   2021 真题卷（含题库、音频、OCR 中间文件）
data/            数据库和配置（别删 .oss-config.json）
```

## 六、当前进度（一句话）

已完成 M1-M4（登录做题 → 作答存档 → 教师看板 → 题库自动导入），M5 数据分析/接口、M6 AI 诊断未做——详见 `docs-与M2差异与开发方向.md`。
技术细节、接手开发指引请看 **`README-AI.md`**。

## 七、音频文件说明

GitHub 仓库**不含音频文件**（*.mp3 已在 .gitignore，GitHub 单文件限 100MB）。克隆仓库后需手动放置：

- `MT56-PartA-学生完整包/audio/mt56_task1-4.mp3`（demo 卷）
- `2021HKDSE-新卷/audio/2021HKDSE_task1-4.mp3`（2021 真题）

音频文件请从原交付包/考勤资料中复制（见 docs-语音识别配置.md 与提取工具链-使用说明.md）。

## 八、常见问题


- **语音识别配不上？** 按 `docs-语音识别配置.md` 三样配齐（百炼 key、OSS bucket、OSS AccessKey），一条命令自测。
- **打不开卷？** 确认在用 http 访问（8011 那步），不是双击文件。
- **想删掉模拟数据？** 教师端数据是脚本注入的，删 `data/dse.sqlite` 后重启服务器会重建干净数据。
