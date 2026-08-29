# MT56 Paper 3 Part A 员工复制说明

## 这套文件是什么

这是一个可以独立运行的 Paper 3 Part A 数字化训练样板。

- `partA.html`：通用训练程序。通常不要为每套题复制或修改程序逻辑。
- `data/mt56_partA.json`：MT56 的全部题目、答案、逐字稿、音频时间戳和教学信息。
- `audio/`：四个 Task 的音频。
- `assets/mt56/`：地图、步骤图等题目图片。

## 直接查看 MT56

直接双击 `partA.html` 即可查看 MT56。文件夹中的 `data/mt56_partA.js` 是专门用于双击打开的备用数据，请勿删除。

如果要测试其他新题 JSON，请在本文件夹打开终端，运行：

```bash
python3 -m http.server 8011
```

然后在浏览器打开：

```text
http://localhost:8011/partA.html?data=data/mt56_partA.json
```

## 复制一套新题

建议保留一份共用的 `partA.html`，每套新题只新增以下资料：

```text
data/新题ID_partA.json
audio/新题ID_task1.mp3
audio/新题ID_task2.mp3
...
assets/新题ID/题目图片.png
```

复制 `data/mt56_partA.json` 作为模板后，需要逐项替换：

1. 顶层的 `id`、`year`、`title`、`totalMarks`、`situation`。
2. 每个 Task 的 `title`、`marks`、`instructions` 和 `audio`。
3. `tapescript` 中的说话者及全文。
4. `blocks` 中的题干、选项、图片路径和答案。
5. 每题的 `signal`、`cloze`。
6. 每题 `ts.signal` 与 `ts.answer` 的音频起止秒数。

完成后，用以下网址检查新题：

```text
http://localhost:8011/partA.html?data=data/新题ID_partA.json
```

## 每题核心字段

```json
{
  "no": 1,
  "answer": ["参考答案"],
  "signal": "答案出现前的提示句",
  "cloze": "学生需要精听的完整答案句",
  "ts": {
    "signal": [12.3, 16.8],
    "answer": [16.8, 21.4]
  }
}
```

- `signal`：帮助学生预测答案即将出现。
- `cloze`：错题精听阶段要求学生听写的目标句。
- `ts.signal`：提示句在音频中的起止时间。
- `ts.answer`：答案句在音频中的起止时间。

## 交付前检查

- 页面能正常载入，没有“无法加载数据”。
- 每个 Task 的音频都能播放。
- 图片题全部显示。
- 所有题都可以作答和批改。
- 每道题的“信号句”和“答案句”按钮播放正确区间。
- 正确答案、可接受答案和拼写变体已经核对。
- 全文 tapescript 与录音一致。

## 不建议员工改动

- 不要把答案直接写进 HTML。
- 不要每套题复制一份不同版本的训练程序。
- 不要删除 `signal`、`cloze` 或 `ts`；它们是精听流程的核心。
- 不要用 Word、Excel 或聊天软件重新保存 JSON，以免破坏格式。
