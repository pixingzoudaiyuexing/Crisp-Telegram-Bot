const CRISP_API_BASE = "https://api.crisp.chat/v1";
const TELEGRAM_API_BASE = "https://api.telegram.org";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && path === "/") {
        return json({ ok: true, service: "crisp-telegram-ai-worker" });
      }

      if (request.method === "GET" && path === "/setup-telegram") {
        return setupTelegram(request, env);
      }

      if (request.method === "POST" && path.startsWith("/telegram/")) {
        const secret = decodeURIComponent(path.slice("/telegram/".length));
        if (!safeEquals(secret, env.TELEGRAM_SECRET || "")) return text("forbidden", 403);

        const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (!safeEquals(headerSecret, env.TELEGRAM_SECRET || "")) return text("forbidden", 403);

        const update = await request.json();
        ctx.waitUntil(handleTelegramUpdate(update, env));
        return json({ ok: true });
      }

      if (request.method === "POST" && path.startsWith("/crisp/")) {
        const secret = decodeURIComponent(path.slice("/crisp/".length));
        if (!safeEquals(secret, env.CRISP_HOOK_PATH_SECRET || "")) return text("forbidden", 403);

        const rawBody = await request.text();
        if (env.CRISP_HOOK_SECRET) {
          const verified = await verifyCrispSignature(request, rawBody, env.CRISP_HOOK_SECRET);
          if (!verified) return text("bad signature", 401);
        }

        const hook = JSON.parse(rawBody);
        ctx.waitUntil(handleCrispHook(hook, env));
        return json({ ok: true });
      }

      return text("not found", 404);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: String(error?.message || error) }, 500);
    }
  }
};

async function setupTelegram(request, env) {
  const url = new URL(request.url);
  if (!safeEquals(url.searchParams.get("secret") || "", env.TELEGRAM_SECRET || "")) {
    return text("forbidden", 403);
  }

  const webhookUrl = `${url.origin}/telegram/${encodeURIComponent(env.TELEGRAM_SECRET)}`;
  const result = await telegramCall(env, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true
  });

  return json({ ok: true, webhookUrl, result });
}

async function handleTelegramUpdate(update, env) {
  if (update.callback_query) {
    await handleTelegramCallback(update.callback_query, env);
    return;
  }

  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  if (String(msg.chat?.id) !== String(env.BOT_GROUPID)) return;

  if (msg.text) {
    await handleTelegramText(msg, env);
    return;
  }

  if (msg.photo || isImageDocument(msg.document)) {
    await handleTelegramImage(msg, env);
  }
}

async function handleTelegramText(msg, env) {
  const threadId = msg.message_thread_id;
  if (!threadId) return;

  const sessionId = await env.STATE.get(threadKey(threadId));
  const command = String(msg.text || "").trim().split(/\s+/)[0].split("@")[0];

  if (command === "/ai_on" || command === "/ai_off") {
    if (!sessionId) {
      await telegramText(env, threadId, "未找到对应 Crisp 会话。");
      return;
    }

    const session = await getSession(env, sessionId);
    if (!session) {
      await telegramText(env, threadId, "未找到对应 Crisp 会话。");
      return;
    }

    if (command === "/ai_on") {
      setAi(session, true);
      await saveSession(env, sessionId, session);
      await telegramText(env, threadId, "AI 自动回复已打开。");
    } else {
      setAi(session, false, "manual", notifyMode(env.TG_NOTIFY_WHEN_MANUAL_OFF, "silent"));
      await saveSession(env, sessionId, session);
      await telegramText(env, threadId, "AI 自动回复已关闭。");
    }
    return;
  }

  if (!sessionId) {
    await telegramText(env, threadId, "未找到对应 Crisp 会话，无法转发。");
    return;
  }

  const session = await getSession(env, sessionId);
  if (!session) return;

  setAi(session, false, "operator", notifyMode(env.TG_NOTIFY_WHEN_TELEGRAM_OPERATOR, "normal"));
  await saveSession(env, sessionId, session);
  await logEvent(env, "operator_reply", sessionId, msg.text, null, { telegramThreadId: threadId });

  await recordEcho(env, sessionId, msg.text);
  await sendCrispMessage(env, sessionId, operatorTextMessage(env, msg.text));
}

async function handleTelegramImage(msg, env) {
  const threadId = msg.message_thread_id;
  if (!threadId) return;

  const sessionId = await env.STATE.get(threadKey(threadId));
  if (!sessionId) {
    await telegramText(env, threadId, "未找到对应 Crisp 会话，无法发送图片。");
    return;
  }

  const session = await getSession(env, sessionId);
  if (!session) return;

  const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
  const file = await telegramCall(env, "getFile", { file_id: fileId });
  const sourceUrl = `${TELEGRAM_API_BASE}/file/bot${env.BOT_TOKEN}/${file.result.file_path}`;
  const imageUrl = await uploadToEasyImagesIfEnabled(env, sourceUrl);
  const markdown = `![Image](${imageUrl})`;

  setAi(session, false, "operator", notifyMode(env.TG_NOTIFY_WHEN_TELEGRAM_OPERATOR, "normal"));
  await saveSession(env, sessionId, session);

  await recordEcho(env, sessionId, markdown);
  await sendCrispMessage(env, sessionId, operatorTextMessage(env, markdown));

  if (isImageLearningEnabled(env)) {
    await logEvent(env, "operator_image_reply", sessionId, "人工发送图片", null, {
      imageUrl,
      sourceUrl,
      markdown,
      telegramThreadId: threadId
    });
  }

  await telegramText(env, threadId, "图片已成功发送给客户。");
}

async function handleTelegramCallback(query, env) {
  const [sessionId, action] = String(query.data || "").split(",");
  if (!sessionId || !action) return;

  const session = await getSession(env, sessionId);
  if (!session) {
    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "未找到对应会话"
    });
    return;
  }

  if (action === "on") {
    setAi(session, true);
    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "AI 自动回复已打开"
    });
  } else if (action === "off") {
    setAi(session, false, "manual", notifyMode(env.TG_NOTIFY_WHEN_MANUAL_OFF, "silent"));
    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "AI 自动回复已关闭"
    });
  }

  await saveSession(env, sessionId, session);

  if (query.message) {
    await telegramCall(env, "editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: aiKeyboard(sessionId)
    }).catch(() => null);
  }
}

async function handleCrispHook(hook, env) {
  const event = hook.event;
  const data = hook.data || hook;

  if (hook.website_id && env.CRISP_WEBSITE && hook.website_id !== env.CRISP_WEBSITE) return;
  if (data.website_id && env.CRISP_WEBSITE && data.website_id !== env.CRISP_WEBSITE) return;
  if (!data.session_id) return;
  if (!["message:send", "message:received", "session:set_data"].includes(event)) return;

  const session = await ensureSession(env, data);
  if (event === "session:set_data") {
    await updateMetasMessage(env, data.session_id, session).catch((error) => console.warn("update metas failed", error));
    return;
  }

  await handleCrispMessage(env, event, data, session);
}

async function ensureSession(env, data) {
  const sessionId = data.session_id;
  const existing = await getSession(env, sessionId);
  if (existing) return existing;

  const title = truncate(data.user?.nickname || data.user?.user_id || sessionId, 128) || "Crisp 会话";
  const topic = await telegramCall(env, "createForumTopic", {
    chat_id: env.BOT_GROUPID,
    name: title
  });

  const topicId = topic.result.message_thread_id;
  const metas = await getSessionMeta(env, sessionId);
  const metasText = formatMetas(metas);
  const metaMsg = await telegramCall(env, "sendMessage", {
    chat_id: env.BOT_GROUPID,
    message_thread_id: topicId,
    text: metasText,
    reply_markup: aiKeyboard(sessionId)
  });

  const session = {
    topicId,
    messageId: metaMsg.result.message_id,
    enableAI: Boolean(env.OPENAI_APIKEY),
    aiPausedBy: null,
    lastOperatorReplyAt: null,
    tgNotifyMode: "normal",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await saveSession(env, sessionId, session);
  await env.STATE.put(threadKey(topicId), sessionId);
  return session;
}

async function updateMetasMessage(env, sessionId, session) {
  const metas = await getSessionMeta(env, sessionId);
  await telegramCall(env, "editMessageText", {
    chat_id: env.BOT_GROUPID,
    message_id: session.messageId,
    text: formatMetas(metas),
    reply_markup: aiKeyboard(sessionId)
  });
}

async function handleCrispMessage(env, event, data, session) {
  const sessionId = data.session_id;
  const from = data.from;

  if (from !== "user") {
    if (await consumeEcho(env, sessionId, data.content)) return;

    if (from === "operator") {
      setAi(session, false, "operator", notifyMode(env.TG_NOTIFY_WHEN_CRISP_OPERATOR, "silent"));
      await saveSession(env, sessionId, session);
      await sendTelegramTextToSession(env, session, `人工客服已接入：AI 自动回复已暂停。\n\n人工回复：${formatContent(data.content)}`, {
        reply_markup: aiKeyboard(sessionId)
      });
      await logEvent(env, "operator_reply", sessionId, formatContent(data.content), await getSessionMeta(env, sessionId), {
        source: "crisp",
        event
      });
    }
    return;
  }

  if (data.fingerprint) {
    await markCrispRead(env, sessionId, data.fingerprint).catch((error) => console.warn("mark crisp read failed", error));
  }

  if (data.type === "text") {
    await handleCrispText(env, data, session);
    return;
  }

  if (data.type === "file" && isImageMessage(data)) {
    await handleCrispImage(env, data, session);
  }
}

async function handleCrispText(env, data, session) {
  const sessionId = data.session_id;
  const content = String(data.content || "");
  const meta = await getSessionMeta(env, sessionId);

  await logEvent(env, "user_message", sessionId, content, meta);

  const flow = ["消息推送", "", `消息内容：${content}`];
  if (maybeAutoResumeAi(session, env)) {
    flow.push("", `AI 状态：人工超过 ${Number(env.AI_AUTO_RESUME_MINUTES || 30)} 分钟未回复，AI 自动回复已恢复。`);
    await saveSession(env, sessionId, session);
  }

  let autoReply = null;
  if (session.enableAI) {
    autoReply = getKeywordReply(env, content);
    if (autoReply) flow.push("", `自动回复：${autoReply}`);
  }

  if (!autoReply && session.enableAI && env.OPENAI_APIKEY) {
    try {
      autoReply = await createAiReply(env, content);
      flow.push("", `自动回复：${autoReply}`);
    } catch (error) {
      flow.push("", `自动回复：AI 服务调用失败：${String(error?.message || error)}`);
    }
  }

  if (autoReply) {
    await logEvent(env, "ai_reply", sessionId, autoReply, meta);
    await recordEcho(env, sessionId, autoReply);
    await sendCrispMessage(env, sessionId, {
      type: "text",
      content: autoReply,
      from: "operator",
      origin: "chat",
      user: {
        nickname: env.AI_NICKNAME || "智能客服",
        avatar: env.AI_AVATAR || undefined
      }
    });
  }

  await sendTelegramTextToSession(env, session, flow.join("\n"), {
    reply_markup: aiKeyboard(sessionId)
  });
}

async function handleCrispImage(env, data, session) {
  const sessionId = data.session_id;
  const sourceUrl = getCrispImageUrl(data);
  if (!sourceUrl) return;

  let imageUrl = sourceUrl;
  if (isImageLearningEnabled(env)) {
    imageUrl = await uploadToEasyImagesIfEnabled(env, sourceUrl).catch((error) => {
      console.warn("upload user image failed", error);
      return sourceUrl;
    });

    await logEvent(env, "user_image", sessionId, "用户发送图片", await getSessionMeta(env, sessionId), {
      imageUrl,
      sourceUrl,
      telegramThreadId: session.topicId
    });
  }

  await sendTelegramPhotoToSession(env, session, sourceUrl, {
    reply_markup: aiKeyboard(sessionId)
  });
}

function operatorTextMessage(env, content) {
  return {
    type: "text",
    content,
    from: "operator",
    origin: "chat",
    user: {
      nickname: env.OPERATOR_NICKNAME || "人工客服",
      avatar: env.OPERATOR_AVATAR || undefined
    }
  };
}

async function getSessionMeta(env, sessionId) {
  try {
    const body = await crispCall(env, "GET", `/website/${env.CRISP_WEBSITE}/conversation/${sessionId}/meta`);
    const meta = body.data || {};
    const data = meta.data || {};
    const usedTraffic = getMetaValue(data, "UsedTraffic", "usedTraffic", "used_traffic");
    const allTraffic = getMetaValue(data, "AllTraffic", "allTraffic", "all_traffic");

    return {
      email: meta.email || getMetaValue(data, "email"),
      plan: getMetaValue(data, "plan", "Plan"),
      expired: getMetaValue(data, "expired", "Expired", "expire", "expires_at", "expired_at", "expire_at"),
      traffic: usedTraffic && allTraffic ? `${formatMetaValue(usedTraffic)} / ${formatMetaValue(allTraffic)}` : null
    };
  } catch (error) {
    console.warn("get crisp meta failed", error);
    return {};
  }
}

function formatMetas(meta) {
  const flow = ["Crisp消息推送", ""];
  if (meta.email) flow.push(`电子邮箱：${formatMetaValue(meta.email)}`);
  if (meta.plan) flow.push(`使用套餐：${formatMetaValue(meta.plan)}`);
  if (meta.expired) flow.push(`到期时间：${formatMetaValue(meta.expired)}`);
  if (meta.traffic) flow.push(`流量信息：${meta.traffic}`);
  return flow.length > 2 ? flow.join("\n") : "无额外信息";
}

function getMetaValue(data, ...keys) {
  if (!data || typeof data !== "object") return null;
  const lower = Object.fromEntries(Object.entries(data).map(([key, value]) => [String(key).toLowerCase(), value]));
  for (const key of keys) {
    const value = data[key] ?? lower[String(key).toLowerCase()];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
}

function formatMetaValue(value) {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function getKeywordReply(env, content) {
  let rules = {};
  try {
    rules = JSON.parse(env.AUTOREPLY_JSON || "{}");
  } catch {
    return null;
  }

  for (const [pattern, reply] of Object.entries(rules)) {
    for (const keyword of pattern.split("|")) {
      if (keyword && content.includes(keyword)) return String(reply);
    }
  }
  return null;
}

async function createAiReply(env, content) {
  const baseUrl = String(env.OPENAI_BASEURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_APIKEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: env.OPENAI_PAYLOAD || "请用简体中文作为客服，简短、自然地回复用户。" },
        { role: "user", content }
      ]
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `${response.status} ${response.statusText}`);
  }

  return body.choices?.[0]?.message?.content || "";
}

function setAi(session, enabled, pausedBy = null, notify = null) {
  session.enableAI = Boolean(enabled);
  if (enabled) {
    session.aiPausedBy = null;
    session.lastOperatorReplyAt = null;
    session.tgNotifyMode = "normal";
  } else if (pausedBy === "operator") {
    session.aiPausedBy = "operator";
    session.lastOperatorReplyAt = Date.now();
    session.tgNotifyMode = notifyMode(notify, "normal");
  } else {
    session.aiPausedBy = "manual";
    session.lastOperatorReplyAt = null;
    session.tgNotifyMode = notifyMode(notify, "silent");
  }
  session.updatedAt = Date.now();
}

function maybeAutoResumeAi(session, env) {
  const minutes = Number(env.AI_AUTO_RESUME_MINUTES || 30);
  if (!env.OPENAI_APIKEY || session.enableAI || session.aiPausedBy !== "operator" || minutes <= 0 || !session.lastOperatorReplyAt) {
    return false;
  }
  if (Date.now() - Number(session.lastOperatorReplyAt) < minutes * 60 * 1000) return false;

  setAi(session, true);
  return true;
}

function notifyMode(value, fallback = "normal") {
  const mode = String(value || fallback).trim().toLowerCase();
  return mode === "silent" ? "silent" : "normal";
}

async function getSession(env, sessionId) {
  return env.STATE.get(sessionKey(sessionId), "json");
}

async function saveSession(env, sessionId, session) {
  session.updatedAt = Date.now();
  await env.STATE.put(sessionKey(sessionId), JSON.stringify(session));
}

function sessionKey(sessionId) {
  return `session:${sessionId}`;
}

function threadKey(threadId) {
  return `thread:${threadId}`;
}

function echoKey(sessionId, content) {
  return `echo:${sessionId}:${hashString(String(content))}`;
}

async function recordEcho(env, sessionId, content) {
  if (!content) return;
  await env.STATE.put(echoKey(sessionId, content), "1", { expirationTtl: 300 });
}

async function consumeEcho(env, sessionId, content) {
  if (!content) return false;
  const key = echoKey(sessionId, content);
  const hit = await env.STATE.get(key);
  if (!hit) return false;
  await env.STATE.delete(key);
  return true;
}

async function sendTelegramTextToSession(env, session, textValue, extra = {}) {
  return telegramCall(env, "sendMessage", {
    chat_id: env.BOT_GROUPID,
    message_thread_id: session.topicId,
    text: truncate(textValue, 4096),
    disable_notification: session.tgNotifyMode === "silent",
    ...extra
  });
}

async function sendTelegramPhotoToSession(env, session, photo, extra = {}) {
  return telegramCall(env, "sendPhoto", {
    chat_id: env.BOT_GROUPID,
    message_thread_id: session.topicId,
    photo,
    disable_notification: session.tgNotifyMode === "silent",
    ...extra
  });
}

async function telegramText(env, threadId, textValue) {
  return telegramCall(env, "sendMessage", {
    chat_id: env.BOT_GROUPID,
    message_thread_id: threadId,
    text: textValue
  });
}

async function telegramCall(env, method, payload) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function crispCall(env, method, path, body) {
  const headers = {
    "Authorization": `Basic ${btoa(`${env.CRISP_ID}:${env.CRISP_KEY}`)}`,
    "X-Crisp-Tier": "plugin"
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${CRISP_API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Crisp ${method} ${path} failed: ${JSON.stringify(responseBody)}`);
  }
  return responseBody;
}

async function sendCrispMessage(env, sessionId, message) {
  return crispCall(env, "POST", `/website/${env.CRISP_WEBSITE}/conversation/${sessionId}/message`, message);
}

async function markCrispRead(env, sessionId, fingerprint) {
  return crispCall(env, "PATCH", `/website/${env.CRISP_WEBSITE}/conversation/${sessionId}/read`, {
    from: "user",
    origin: "chat",
    fingerprints: [fingerprint]
  });
}

function aiKeyboard(sessionId) {
  return {
    inline_keyboard: [[
      { text: "/ai_on 打开 AI", callback_data: `${sessionId},on` },
      { text: "/ai_off 关闭 AI", callback_data: `${sessionId},off` }
    ]]
  };
}

async function uploadToEasyImagesIfEnabled(env, sourceUrl) {
  if (!env.EASYIMAGES_API_URL || !env.EASYIMAGES_API_TOKEN) return sourceUrl;

  const image = await fetch(sourceUrl);
  if (!image.ok) throw new Error(`download image failed: ${image.status}`);

  const form = new FormData();
  form.append("token", env.EASYIMAGES_API_TOKEN);
  form.append("image", await image.blob(), "image.jpg");

  const response = await fetch(env.EASYIMAGES_API_URL, { method: "POST", body: form });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.result !== "success") {
    throw new Error(`EasyImages upload failed: ${JSON.stringify(body)}`);
  }
  return body.url;
}

function isImageDocument(document) {
  return Boolean(document && String(document.mime_type || "").startsWith("image/"));
}

function isImageMessage(data) {
  const content = data.content || {};
  return String(content.type || content.mimetype || "").includes("image") || Boolean(getCrispImageUrl(data));
}

function getCrispImageUrl(data) {
  const content = data.content;
  if (!content) return null;
  if (typeof content === "string") return content;
  return content.url || content.href || content.link || null;
}

async function verifyCrispSignature(request, rawBody, secret) {
  const timestamp = request.headers.get("X-Crisp-Request-Timestamp") || "";
  const signature = request.headers.get("X-Crisp-Signature") || "";
  if (!timestamp || !signature) return false;

  const payload = `[${timestamp};${rawBody}]`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const local = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return safeEquals(local, signature);
}

async function logEvent(env, type, sessionId, content = null, meta = null, extra = null) {
  if (String(env.LEARNING_ENABLED ?? "true").toLowerCase() !== "true") return;

  const event = {
    ts: new Date().toISOString(),
    type,
    sessionId,
    content: maskText(content),
    meta: maskMeta(meta)
  };
  if (extra) {
    event.extra = {};
    for (const [key, value] of Object.entries(extra)) {
      event.extra[key] = String(key).toLowerCase().endsWith("url") ? maskUrlText(value) : maskText(value);
    }
  }

  const line = `${JSON.stringify(event)}\n`;
  console.log(line.trim());

  if (!env.LEARNING_LOGS) return;

  const day = new Date().toISOString().slice(0, 10);
  const key = `learning-logs/${day}.jsonl`;
  const old = await env.LEARNING_LOGS.get(key);
  const previous = old ? await old.text() : "";
  await env.LEARNING_LOGS.put(key, previous + line, {
    httpMetadata: { contentType: "application/jsonl; charset=utf-8" }
  });
}

function isImageLearningEnabled(env) {
  return String(env.LEARNING_IMAGE_ENABLED ?? "true").toLowerCase() === "true";
}

function maskText(value) {
  if (value === null || value === undefined) return null;
  let text = String(value);
  text = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]");
  text = text.replace(/https?:\/\/\S+/g, (url) => maskUrlText(url));
  text = text.replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[token]");
  return text;
}

function maskUrlText(value) {
  if (value === null || value === undefined) return null;
  return String(value).replace(/([?&](?:token|key|auth|password|passwd|pwd|access_token|sub|subscribe)=)[^&\s]+/gi, "$1[hidden]");
}

function maskMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  return {
    email: meta.email ? "[email]" : null,
    plan: maskText(meta.plan),
    expired: maskText(meta.expired),
    traffic: maskText(meta.traffic)
  };
}

function formatContent(content) {
  if (content === null || content === undefined) return "";
  return typeof content === "string" ? content : JSON.stringify(content);
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function safeEquals(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index++) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function text(value, status = 200) {
  return new Response(value, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
