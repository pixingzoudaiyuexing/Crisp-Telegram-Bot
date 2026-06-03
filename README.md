# Crisp Telegram AI Bot

把 Crisp 客服消息同步到 Telegram 话题群，并支持 OpenAI 兼容接口自动回复、人工接入暂停 AI、图片学习日志和 Telegram 静默通知。

## 功能

- Crisp 用户消息自动推送到 Telegram Topic 话题
- Telegram 话题内回复，可转发回对应 Crisp 会话
- 支持 Crisp 后台人工回复事件同步
- 支持关键词自动回复 `AUTOREPLY`
- 支持 OpenAI 兼容接口自动回复
- 每条用户消息下面带 `/ai_on`、`/ai_off` 按钮
- 人工从 Telegram 或 Crisp 接入后，AI 自动暂停
- 支持设置人工超时后 AI 自动恢复
- 支持用户邮箱、套餐、到期时间、流量信息展示到 Telegram
- 支持 Telegram 人工发送图片，经 EasyImages 上传后发给 Crisp 用户
- 支持用户图片上传到 EasyImages，并写入学习日志
- 支持记录用户问题、AI 回复、人工回复、图片链接到 `learning_logs.jsonl`
- 支持 Crisp 人工接入或手动关闭 AI 后，Telegram 后续消息静默推送
- 支持 Docker / Docker Compose 部署

## 部署

推荐使用 Docker Compose。

```bash
mkdir -p /www/wwwroot/crisp-tg-ai
cd /www/wwwroot/crisp-tg-ai
wget -O docker-compose.yml https://raw.githubusercontent.com/pixingzoudaiyuexing/Crisp-Telegram-Bot/master/docker-compose.yml.example
nano docker-compose.yml
docker compose up -d
```

更新镜像：

```bash
cd /www/wwwroot/crisp-tg-ai
docker compose pull
docker compose up -d
```

查看日志：

```bash
docker compose logs -f
```

## Docker Compose 配置

复制 `docker-compose.yml.example` 后，按注释填写配置。

核心参数：

| 变量 | 说明 |
| --- | --- |
| `BOT_TOKEN` | Telegram Bot Token |
| `BOT_GROUPID` | Telegram 话题群 ID |
| `CRISP_ID` | Crisp 插件 ID |
| `CRISP_KEY` | Crisp 插件 Key |
| `CRISP_WEBSITE` | Crisp 网站 ID |
| `OPENAI_APIKEY` | 第三方 OpenAI 兼容接口 Key |
| `OPENAI_BASEURL` | OpenAI 兼容接口地址，需要包含 `/v1` |
| `OPENAI_MODEL` | 模型名称 |
| `OPENAI_PAYLOAD` | AI 客服提示词和知识库 |
| `AUTOREPLY` | 关键词自动回复 |
| `EasyImages_apiUrl` | EasyImages 图床 API 地址 |
| `EasyImages_apiToken` | EasyImages 图床 Token |

## AI 控制

每条用户消息下方都有两个按钮：

- `/ai_on 打开 AI`
- `/ai_off 关闭 AI`

默认逻辑：

- 新会话 AI 默认开启
- Telegram 人工回复后，AI 自动暂停
- Crisp 后台人工回复后，AI 自动暂停
- 手动点击 `/ai_off` 后，AI 保持关闭
- 手动点击 `/ai_on` 后，AI 恢复
- 容器重启后，会话状态会重置

## AI 自动恢复

通过 `AI_AUTO_RESUME_MINUTES` 设置人工接入后多久自动恢复 AI。

```yaml
AI_AUTO_RESUME_MINUTES: "30"
```

含义：

- 人工最后一次回复后，超过 30 分钟
- 用户再次发消息时，AI 自动恢复并处理
- 设置为 `"0"` 表示永不自动恢复

手动点击 `/ai_off` 属于手动关闭，不会被自动恢复。

## Telegram 静默通知

可以控制 AI 暂停后，Telegram 是否继续响铃。

```yaml
TG_NOTIFY_WHEN_CRISP_OPERATOR: silent
TG_NOTIFY_WHEN_TELEGRAM_OPERATOR: normal
TG_NOTIFY_WHEN_MANUAL_OFF: silent
```

可选值：

- `normal`：正常推送，有通知提醒
- `silent`：静默推送，不响铃

推荐逻辑：

- 新会话 AI 开启：TG 正常提醒
- 人工从 Telegram 回复：AI 暂停，TG 默认正常提醒
- 人工从 Crisp 回复：AI 暂停，TG 默认静默
- 手动 `/ai_off`：TG 默认静默
- 手动 `/ai_on`：TG 恢复正常提醒
- 超过 `AI_AUTO_RESUME_MINUTES` 自动恢复：TG 恢复正常提醒

## 学习日志

学习日志默认保存到：

```text
./data/learning_logs.jsonl
```

相关配置：

```yaml
LEARNING_ENABLED: "true"
LEARNING_IMAGE_ENABLED: "true"
LEARNING_LOG_PATH: /Crisp-Telegram-Bot/data/learning_logs.jsonl
```

会记录的事件：

| 类型 | 说明 |
| --- | --- |
| `user_message` | 用户文字消息 |
| `ai_reply` | AI 自动回复 |
| `operator_reply` | 人工文字回复 |
| `user_image` | 用户发送的图片 |
| `operator_image_reply` | 人工从 Telegram 发送的图片 |

图片处理：

- `LEARNING_IMAGE_ENABLED=true` 时，用户图片会记录为 `user_image`
- `LEARNING_IMAGE_ENABLED=true` 时，Telegram 人工图片会记录为 `operator_image_reply`
- 用户在 Crisp 发图片时，会上传到 EasyImages
- Telegram 人工发图片时，也会上传到 EasyImages
- 日志里保存图片链接，方便后续整理知识库
- 日志会对邮箱、长 token、敏感 URL 参数做基础脱敏

查看日志：

```bash
tail -f ./data/learning_logs.jsonl
```

## 图片发送

Telegram 人工客服可以在对应话题里发送图片。

流程：

1. Bot 下载 Telegram 图片
2. 上传到 EasyImages
3. 生成 Markdown 图片链接
4. 发送到 Crisp 用户会话
5. 写入学习日志

需要配置：

```yaml
EasyImages_apiUrl: "https://example.com/api/index.php"
EasyImages_apiToken: "your_token"
```

## OpenAI 兼容接口

接口地址需要包含 `/v1`，例如：

```yaml
OPENAI_BASEURL: https://api.openai.com/v1
```

第三方中转接口也需要使用 OpenAI Chat Completions 兼容格式：

```text
POST /v1/chat/completions
```

AI 只在需要自动回复时调用接口。容器空跑、人工回复、AI 关闭、关键词自动回复命中时，不会消耗 OpenAI token。

## Telegram 准备

1. 使用 BotFather 创建 Bot，获取 `BOT_TOKEN`
2. 创建 Telegram 群
3. 打开群的 Topic / 话题功能
4. 将 Bot 拉入群
5. 给 Bot 管理员权限
6. 获取群 ID，填入 `BOT_GROUPID`

注意：同一个 Bot Token 只能运行一个 polling 实例。如果日志出现：

```text
Conflict: terminated by other getUpdates request
```

说明同一个 Bot Token 正在别处运行，需要停止重复实例。

## Crisp 准备

需要 Crisp Marketplace 插件信息：

- 插件 ID
- 插件 Key
- 网站 ID

插件需要具备会话和消息相关权限。程序会使用 Crisp API 和 RTM 事件：

- `message:send`
- `message:received`
- `session:set_data`

其中 `message:send` 用于用户消息，`message:received` 用于 Crisp 后台人工客服回复。

## 常用命令

启动：

```bash
docker compose up -d
```

停止：

```bash
docker compose down
```

更新：

```bash
docker compose pull
docker compose up -d
```

看日志：

```bash
docker compose logs -f
```

确认容器配置：

```bash
docker compose exec bot cat /Crisp-Telegram-Bot/config.yml
```

确认学习日志：

```bash
tail -n 50 ./data/learning_logs.jsonl
```

## 安全建议

- 不要把真实 Bot Token、Crisp Key、OpenAI Key 提交到公开仓库
- 图床链接可能包含用户截图，请确认图床访问权限和隐私策略
- `learning_logs.jsonl` 里可能有客服对话信息，建议仅内部使用
- 生产环境建议定期轮换 Token 和 Key
