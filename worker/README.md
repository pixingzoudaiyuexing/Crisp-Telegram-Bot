# Cloudflare Worker 版

这是 Crisp Telegram AI Bot 的 Cloudflare Worker 版本。它不使用 Docker，不使用 Telegram polling，也不使用 Crisp RTM 长连接，而是改成：

```text
Crisp WebHook -> Worker -> Telegram Bot API
Telegram WebHook -> Worker -> Crisp REST API
```

## 已支持

- Crisp 用户消息推送到 Telegram Topic
- Telegram Topic 回复转发到 Crisp
- `/ai_on`、`/ai_off` 命令和按钮
- Crisp 后台人工回复同步到 Telegram，并暂停 AI
- Telegram 人工回复后暂停 AI
- 关键词自动回复
- OpenAI 兼容接口自动回复
- 人工超时后 AI 自动恢复
- Crisp 用户邮箱、套餐、到期时间、流量展示
- Crisp 用户图片推送到 Telegram
- Telegram 人工图片上传 EasyImages 后发给 Crisp
- 用户图片和人工图片学习日志
- Crisp 人工接入、手动 `/ai_off` 后 Telegram 静默通知

## 和 Docker 版的区别

- Docker 版使用 Python + Telegram polling + Crisp RTM。
- Worker 版使用 JavaScript + Telegram Webhook + Crisp WebHook。
- Worker 没有本地文件系统，学习日志默认输出到 Worker Logs。
- 如果绑定 R2 bucket `LEARNING_LOGS`，日志会按日期保存为 `learning-logs/YYYY-MM-DD.jsonl`。
- 状态存储使用 Cloudflare KV：会话 ID、Telegram topic ID、AI 开关、人工暂停状态。

## 部署步骤

进入 worker 目录：

```bash
cd worker
npm install
```

登录 Cloudflare：

```bash
npx wrangler login
```

创建 KV：

```bash
npx wrangler kv namespace create STATE
```

复制配置：

```bash
cp wrangler.toml.example wrangler.toml
nano wrangler.toml
```

把 KV 输出的 `id` 填入 `wrangler.toml`。

可选：创建 R2 保存学习日志：

```bash
npx wrangler r2 bucket create crisp-tg-learning
```

然后取消 `wrangler.toml` 里 `[[r2_buckets]]` 的注释。

写入 secrets：

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put TELEGRAM_SECRET
npx wrangler secret put CRISP_ID
npx wrangler secret put CRISP_KEY
npx wrangler secret put CRISP_HOOK_PATH_SECRET
npx wrangler secret put CRISP_HOOK_SECRET
npx wrangler secret put OPENAI_APIKEY
npx wrangler secret put EASYIMAGES_API_TOKEN
```

不使用 AI 可以不设置 `OPENAI_APIKEY`。不使用 EasyImages 可以不设置 `EASYIMAGES_API_TOKEN`。

部署：

```bash
npm run deploy
```

## 设置 Telegram Webhook

部署后访问：

```text
https://你的-worker-url/setup-telegram?secret=你的 TELEGRAM_SECRET
```

返回 `ok: true` 说明设置成功。

## 设置 Crisp WebHook

在 Crisp WebHook 里填写：

```text
https://你的-worker-url/crisp/你的 CRISP_HOOK_PATH_SECRET
```

订阅事件：

- `message:send`
- `message:received`
- `session:set_data`

如果 Crisp 提供 signing secret，把它写到：

```bash
npx wrangler secret put CRISP_HOOK_SECRET
```

Worker 会用原始请求 body 校验 `X-Crisp-Signature`。

## 配置说明

| 变量 | 说明 |
| --- | --- |
| `BOT_TOKEN` | Telegram Bot Token |
| `BOT_GROUPID` | Telegram 话题群 ID |
| `TELEGRAM_SECRET` | Telegram Webhook 路径和 header 校验密钥 |
| `CRISP_ID` | Crisp 插件 ID |
| `CRISP_KEY` | Crisp 插件 Key |
| `CRISP_WEBSITE` | Crisp 网站 ID |
| `CRISP_HOOK_PATH_SECRET` | Crisp WebHook URL 路径密钥 |
| `CRISP_HOOK_SECRET` | Crisp WebHook 签名密钥 |
| `OPENAI_APIKEY` | OpenAI 兼容接口 Key |
| `OPENAI_BASEURL` | OpenAI 兼容接口地址，需要包含 `/v1` |
| `OPENAI_MODEL` | 模型名称 |
| `OPENAI_PAYLOAD` | AI 客服提示词 |
| `AUTOREPLY_JSON` | 关键词回复 JSON |
| `AI_AUTO_RESUME_MINUTES` | 人工多久未回复后自动恢复 AI，`0` 表示不恢复 |
| `TG_NOTIFY_WHEN_CRISP_OPERATOR` | Crisp 人工接入后 TG 是否静默，`normal` / `silent` |
| `TG_NOTIFY_WHEN_TELEGRAM_OPERATOR` | Telegram 人工接入后 TG 是否静默 |
| `TG_NOTIFY_WHEN_MANUAL_OFF` | 手动 `/ai_off` 后 TG 是否静默 |
| `LEARNING_ENABLED` | 是否记录学习日志 |
| `LEARNING_IMAGE_ENABLED` | 是否记录双方图片学习日志 |
| `EASYIMAGES_API_URL` | EasyImages API |
| `EASYIMAGES_API_TOKEN` | EasyImages Token |

## 学习日志

日志类型：

- `user_message`
- `ai_reply`
- `operator_reply`
- `user_image`
- `operator_image_reply`

如果没有绑定 R2，日志只会出现在 Worker Logs。

如果绑定 R2，会保存为：

```text
learning-logs/2026-06-03.jsonl
```

注意：R2 追加日志是读取旧文件再写回，免费版小流量够用。如果后面消息量很大，建议改成 D1 或按小时切分日志。

## 免费版 Cloudflare 是否够用

这个 Worker 版按 Webhook 触发，一条消息通常对应 1 次 Worker 请求。免费版 Workers 每天 100,000 次请求，一般客服场景够用。

真正要注意的是：

- 不适合用长连接，所以必须使用 Webhook
- KV 是最终一致存储，普通客服消息够用
- 大量并发或强一致状态，可以再升级到 Durable Object / D1
- 图片不要存在 Worker 内，继续用 EasyImages 或 R2

## 本地检查

```bash
npm run check
```
