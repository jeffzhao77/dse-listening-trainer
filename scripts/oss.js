/**
 * OSS 上传工具 —— 本地音频 → 公网签名 URL（供 DashScope 语音转写 file_urls 使用）
 *
 * 配置（优先级：参数 > 环境变量 > data/.oss-config.json）：
 *   OSS_REGION（默认 oss-cn-beijing，须与百炼同地域）
 *   OSS_BUCKET
 *   OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET
 *
 * 用法:
 *   node scripts/oss.js <本地文件> [--region oss-cn-beijing] [--bucket xxx] [--access-key-id xxx] [--access-key-secret xxx] [--expires 3600]
 *
 * 注意：AK/SK 属敏感信息，建议用 RAM 子账号最小权限（仅 OSS 上传到指定 bucket），
 *       勿把密钥写进仓库；data/.oss-config.json 已在 .gitignore 建议内。
 */
const fs = require("fs");
const path = require("path");
const OSS = require("ali-oss");

const ROOT = path.join(__dirname, "..");

// ---- 配置读取 ----
function loadConfig() {
  // 只合并「已设置」的环境变量，避免 undefined 覆盖文件配置
  const envCfg = {};
  if (process.env.OSS_REGION) envCfg.region = process.env.OSS_REGION;
  if (process.env.OSS_BUCKET) envCfg.bucket = process.env.OSS_BUCKET;
  if (process.env.OSS_ACCESS_KEY_ID) envCfg.accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  if (process.env.OSS_ACCESS_KEY_SECRET) envCfg.accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  let fileCfg = {};
  const cfgPath = path.join(ROOT, "data", ".oss-config.json");
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch (_) {}
  }
  return { ...fileCfg, ...envCfg };
}

function getClient(opts = {}) {
  const merged = { ...loadConfig() };
  // 只合并「显式传入且非空」的参数，避免 undefined 覆盖配置
  for (const k of ["region", "bucket", "accessKeyId", "accessKeySecret", "ak", "sk"]) {
    if (opts[k] !== undefined && opts[k] !== null && opts[k] !== "") merged[k] = opts[k];
  }
  const region = merged.region || "oss-cn-beijing";
  const bucket = merged.bucket;
  const accessKeyId = merged.accessKeyId || merged.ak;
  const accessKeySecret = merged.accessKeySecret || merged.sk;
  if (!bucket || !accessKeyId || !accessKeySecret) {
    throw new Error(
      "缺少 OSS 配置：bucket / accessKeyId / accessKeySecret\n" +
        "设置环境变量 OSS_BUCKET、OSS_ACCESS_KEY_ID、OSS_ACCESS_KEY_SECRET，或写 data/.oss-config.json，或传参 --bucket/--access-key-id/--access-key-secret"
    );
  }
  return new OSS({ region, bucket, accessKeyId, accessKeySecret });
}

/**
 * 上传本地文件到 OSS，返回公网签名 URL（默认 1 小时有效）
 * @param {string} localPath 本地文件绝对路径
 * @param {object} opts { region, bucket, accessKeyId, accessKeySecret, expires, prefix }
 */
async function uploadToOss(localPath, opts = {}) {
  const abs = path.resolve(localPath);
  if (!fs.existsSync(abs)) throw new Error("文件不存在: " + abs);
  const client = getClient(opts);
  const name = (opts.prefix || "audio") + "/" + Date.now() + "_" + path.basename(abs).replace(/[^\w.\-]/g, "_");
  try {
    await client.put(name, fs.createReadStream(abs));
  } catch (e) {
    // bucket 不存在 → 尝试自动创建（私有）；无建桶权限时给出手动指引
    if (e && (e.code === "NoSuchBucket" || /NoSuchBucket/i.test(String(e.message)))) {
      try {
        console.log("  bucket 不存在，尝试自动创建（私有）…");
        await client.putBucket(client.options.bucket, client.options.region);
        await client.put(name, fs.createReadStream(abs));
      } catch (e2) {
        throw new Error(
          "自动创建 bucket 失败（" + (e2.code || e2.message || e2) + "）。请手动创建：\n" +
            "  oss.console.aliyun.com → 创建 Bucket：名称 dse-audio（或你配置的 OSS_BUCKET）、地域 华北2（北京）、读写权限 私有\n" +
            "  并确认 RAM 用户（dse-oss）已授权 AliyunOSSFullAccess 且权限已生效"
        );
      }
    } else {
      throw e;
    }
  }
  const url = client.signatureUrl(name, { expires: opts.expires || 3600 });
  return url;
}

// ---- CLI ----
function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : d;
  };
  const file = args[0];
  if (!file) {
    console.error("用法: node scripts/oss.js <本地文件> [--region oss-cn-beijing] [--bucket xxx] [--access-key-id xxx] [--access-key-secret xxx] [--expires 3600]");
    process.exit(1);
  }
  uploadToOss(file, {
    region: opt("--region"),
    bucket: opt("--bucket"),
    accessKeyId: opt("--access-key-id"),
    accessKeySecret: opt("--access-key-secret"),
    expires: parseInt(opt("--expires", "3600"), 10),
  })
    .then((url) => {
      console.log("✅ 上传成功，签名 URL（1 小时内可访问）:");
      console.log(url);
    })
    .catch((e) => {
      console.error("❌ " + (e && e.message ? e.message : e));
      process.exit(1);
    });
}

module.exports = { uploadToOss, getClient, loadConfig };
if (require.main === module) main();
