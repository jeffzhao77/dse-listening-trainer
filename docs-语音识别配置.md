# 语音识别（AI 转写）配置说明 — 移交文档

> 给下一任接手者：按此文档配置云端语音识别后，试卷提取工具链才能把完整录音转成带时间戳的句子。
> 接手者的 AI 也可直接调用项目 skill：`/dse-voice-recognition-setup`。

## 要配什么（3 样）

| 凭证 | 用途 | 在哪拿 |
|---|---|---|
| 百炼 API Key（`sk-` 开头） | 调 paraformer-v2 语音识别 | bailian.console.aliyun.com → API-KEY 管理 |
| OSS bucket + AccessKey | 把录音上传为公网 URL（转写接口只收 URL） | oss.console.aliyun.com + ram.console.aliyun.com |

## 配在哪

写 `data/.oss-config.json`：

```json
{
  "region": "oss-cn-beijing",
  "bucket": "你的bucket名",
  "accessKeyId": "LTAI...",
  "accessKeySecret": "..."
}
```

百炼 key 用命令行 `--api-key <key>` 传入（或环境变量 `DASHSCOPE_API_KEY`）。

## 验证（一条命令）

```bash
node scripts/test-api.js --base-url https://dashscope.aliyuncs.com --api-key <key> --model paraformer-v2
```

两项都 `✓` 即配好。

## 日常用法

```bash
# 转写 + 对齐（最常用）
node scripts/audio-align.js 题库.json 完整录音.mp3 --asr dashscope --api-key <key> --model paraformer-v2 --out data/xxx_aligned.json

# 切 Task mp3
node scripts/split-audio.js data/xxx_aligned.json --prefix 卷id

# 填题级 ts（精听数据）
node scripts/fill-ts.js 题库.json data/xxx_aligned.json --out 题库_ts.json
```

## 常见坑（务必知道）

1. **ws- 专属网关（`ws-xxx.maas.aliyuncs.com`）没有语音识别**——compatible-mode 只做对话。语音识别必须用标准百炼 `https://dashscope.aliyuncs.com`（专属空间 key `sk-ws-` 在标准百炼也能用，已验证）。
2. **转写接口只收公网 URL**（file_urls），不收本地文件——程序会自动上传 OSS 解决。
3. **模型用 `paraformer-v2`**（有 36000 秒免费额度，`bl usage free` 可查）；`qwen3-asr-flash-filetrans` 是按量。
4. OSS bucket 必须**华北2（北京）+ 私有**，与百炼同地域免流量费。
5. 密钥只放 `data/.oss-config.json` 或环境变量，别提交仓库/写进日志。

## 详细排障

见项目 skill `/dse-voice-recognition-setup` 第 6 节（故障排查表）。
