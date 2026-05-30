
import bot
import json
import time
import base64
import logging
import socketio
import requests
from telegram.ext import ContextTypes
import learning
import echo_guard

config = bot.config
client = bot.client
openai = bot.openai
changeButton = bot.changeButton
groupId = config["bot"]["groupId"]
websiteId = config["crisp"]["website"]
payload = config["openai"]["payload"]
aiModel = config["openai"].get("model", "gpt-3.5-turbo")
replyUser = config.get("replyUser", {})
aiNickname = replyUser.get("aiNickname", "智能客服")
aiAvatar = replyUser.get("aiAvatar", "https://img.ixintu.com/download/jpg/20210125/8bff784c4e309db867d43785efde1daf_512_512.jpg")
aiAutoResumeMinutes = float(config.get("ai", {}).get("autoResumeMinutes", 30) or 0)

def createAiReply(content: str):
    response = requests.post(
        f"{openai['baseUrl']}/chat/completions",
        headers={
            "Authorization": f"Bearer {openai['apiKey']}",
            "Content-Type": "application/json"
        },
        json={
            "model": aiModel,
            "messages": [
                {"role": "system", "content": payload},
                {"role": "user", "content": content}
            ]
        },
        timeout=60
    )
    response.encoding = "utf-8"
    response.raise_for_status()
    body = response.json()
    return body["choices"][0]["message"]["content"]

def formatAiError(error: Exception):
    response = getattr(error, "response", None)
    status_code = getattr(error, "status_code", None)
    if status_code is None and response is not None:
        status_code = getattr(response, "status_code", None)

    message = getattr(error, "message", None) or str(error)
    if response is not None:
        response.encoding = "utf-8"
        try:
            body = response.json()
            if isinstance(body, dict):
                api_error = body.get("error", body)
                if isinstance(api_error, dict):
                    message = api_error.get("message") or json.dumps(api_error, ensure_ascii=False)
                else:
                    message = str(api_error)
        except Exception:
            try:
                message = response.text
            except Exception:
                pass

    if status_code is not None:
        return f"{status_code}: {message}"
    return message

def getKey(content: str):
    if len(config["autoreply"]) > 0:
        for x in config["autoreply"]:
            keyword = x.split("|")
            for key in keyword:
                if key in content:
                    return True, config["autoreply"][x]
    return False, None

def pauseAiForOperator(session):
    session["enableAI"] = False
    session["aiPausedBy"] = "operator"
    session["lastOperatorReplyAt"] = time.time()

def maybeAutoResumeAi(session):
    if openai is None:
        return False
    if session.get("enableAI") is True:
        return False
    if session.get("aiPausedBy") != "operator":
        return False
    if aiAutoResumeMinutes <= 0:
        return False

    last_reply_at = session.get("lastOperatorReplyAt")
    if last_reply_at is None:
        return False
    if time.time() - last_reply_at < aiAutoResumeMinutes * 60:
        return False

    session["enableAI"] = True
    session["aiPausedBy"] = None
    session["lastOperatorReplyAt"] = None
    return True

def getMetaValue(data: dict, *keys):
    if not isinstance(data, dict):
        return None

    lowerData = {str(key).lower(): value for key, value in data.items()}
    for key in keys:
        value = data.get(key)
        if value is None:
            value = lowerData.get(str(key).lower())
        if value is not None and str(value).strip() != "":
            return value
    return None

def formatMetaValue(value):
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)

def getSessionMeta(sessionId):
    metas = client.website.get_conversation_metas(websiteId, sessionId)
    data = metas.get("data", {})

    email = metas.get("email") or getMetaValue(data, "email")
    plan = getMetaValue(data, "plan", "Plan")
    expired = getMetaValue(data, "expired", "Expired", "expire", "expires_at", "expired_at", "expire_at")
    usedTraffic = getMetaValue(data, "UsedTraffic", "usedTraffic", "used_traffic")
    allTraffic = getMetaValue(data, "AllTraffic", "allTraffic", "all_traffic")

    return {
        "email": email,
        "plan": plan,
        "expired": expired,
        "traffic": f"{formatMetaValue(usedTraffic)} / {formatMetaValue(allTraffic)}" if usedTraffic and allTraffic else None,
    }

def getMetas(sessionId):
    meta = getSessionMeta(sessionId)

    flow = ['📠<b>Crisp消息推送</b>','']

    if meta.get("email"):
        flow.append(f'📧<b>电子邮箱</b>：{formatMetaValue(meta["email"])}')
    if meta.get("plan"):
        flow.append(f"🪪<b>使用套餐</b>：{formatMetaValue(meta['plan'])}")
    if meta.get("expired"):
        flow.append(f"⏰<b>到期时间</b>：{formatMetaValue(meta['expired'])}")
    if meta.get("traffic"):
        flow.append(f"🗒<b>流量信息</b>：{meta['traffic']}")
    if len(flow) > 2:
        return '\n'.join(flow)
    return '无额外信息'


async def createSession(data):
    bot = callbackContext.bot
    botData = callbackContext.bot_data
    sessionId = data["session_id"]
    session = botData.get(sessionId)

    metas = getMetas(sessionId)
    if session is None:
        enableAI = False if openai is None else True
        topic = await bot.create_forum_topic(
            groupId,data["user"]["nickname"])
        msg = await bot.send_message(
            groupId,
            metas,
            message_thread_id=topic.message_thread_id,
            reply_markup=changeButton(sessionId,enableAI)
            )
        botData[sessionId] = {
            'topicId': topic.message_thread_id,
            'messageId': msg.message_id,
            'enableAI': enableAI,
            'aiPausedBy': None,
            'lastOperatorReplyAt': None
        }
    else:
        try:
            await bot.edit_message_text(metas,groupId,session['messageId'])
        except Exception as error:
            print(error)

async def sendMessage(data):
    bot = callbackContext.bot
    botData = callbackContext.bot_data
    sessionId = data["session_id"]
    session = botData.get(sessionId)
    message_from = data.get("from")

    logging.info(
        "Crisp message received: session=%s type=%s from=%s origin=%s fingerprint=%s",
        sessionId,
        data.get("type"),
        message_from,
        data.get("origin"),
        data.get("fingerprint")
    )

    if message_from != "user":
        if echo_guard.consume(sessionId, data.get("content")):
            return
        if session is not None and message_from == "operator":
            pauseAiForOperator(session)
            await bot.send_message(
                groupId,
                f"👩‍💻<b>人工客服已接入</b>：AI 自动回复已暂停。\n\n🧾<b>人工回复</b>：{data.get('content', '')}",
                message_thread_id=session["topicId"],
                reply_markup=changeButton(sessionId, session["enableAI"])
            )
        return

    client.website.mark_messages_read_in_conversation(websiteId,sessionId,
        {"from": "user", "origin": "chat", "fingerprints": [data["fingerprint"]]}
    )

    if data["type"] == "text":
        sessionMeta = getSessionMeta(sessionId)
        learning.log_event("user_message", sessionId, data["content"], sessionMeta)
        flow = ['📠<b>消息推送</b>','']
        flow.append(f"🧾<b>消息内容</b>：{data['content']}")
        resumed_ai = maybeAutoResumeAi(session)
        if resumed_ai:
            flow.append("")
            flow.append(f"⏱<b>AI 状态</b>：人工超过 {aiAutoResumeMinutes:g} 分钟未回复，AI 自动回复已恢复。")

        result, autoreply = False, None
        if session["enableAI"] is True:
            result, autoreply = getKey(data["content"])
        if result is True:
            flow.append("")
            flow.append(f"💡<b>自动回复</b>：{autoreply}")
        elif openai is not None and session["enableAI"] is True:
            try:
                autoreply = createAiReply(data["content"])
                flow.append("")
                flow.append(f"💡<b>自动回复</b>：{autoreply}")
            except Exception as error:
                errorMessage = formatAiError(error)
                logging.exception("AI reply failed: %s", errorMessage)
                flow.append("")
                flow.append(f"💡<b>自动回复</b>：AI 服务调用失败：{errorMessage}")
        
        if autoreply is not None:
            learning.log_event("ai_reply", sessionId, autoreply, sessionMeta)
            query = {
                "type": "text",
                "content": autoreply,
                "from": "operator",
                "origin": "chat",
                "user": {
                    "nickname": aiNickname,
                    "avatar": aiAvatar
                }
            }
            echo_guard.record(sessionId, autoreply)
            client.website.send_message_in_conversation(websiteId, sessionId, query)
        await bot.send_message(
            groupId,
            '\n'.join(flow),
            message_thread_id=session["topicId"],
            reply_markup=changeButton(sessionId, session["enableAI"])
        )
    elif data["type"] == "file" and str(data["content"]["type"]).count("image") > 0:
        await bot.send_photo(
            groupId,
            data["content"]["url"],
            message_thread_id=session["topicId"],
            reply_markup=changeButton(sessionId, session["enableAI"])
        )
    else:
        print("Unhandled Message Type : ", data["type"])

sio = socketio.AsyncClient(reconnection_attempts=5, logger=True)
# Def Event Handlers
@sio.on("connect")
async def connect():
    await sio.emit("authentication", {
        "tier": "plugin",
        "username": config["crisp"]["id"],
        "password": config["crisp"]["key"],
        "events": [
            "message:send",
            "message:received",
            "session:set_data"
        ]})
@sio.on("unauthorized")
async def unauthorized(data):
    print('Unauthorized: ', data)
@sio.event
async def connect_error():
    print("The connection failed!")
@sio.event
async def disconnect():
    print("Disconnected from server.")
@sio.on("message:send")
async def messageForward(data):
    if data["website_id"] != websiteId:
        return
    await createSession(data)
    await sendMessage(data)

@sio.on("message:received")
async def messageReceivedForward(data):
    if data["website_id"] != websiteId:
        return
    await createSession(data)
    await sendMessage(data)

# Meow!
def getCrispConnectEndpoints():
    url = "https://api.crisp.chat/v1/plugin/connect/endpoints"

    authtier = base64.b64encode(
        (config["crisp"]["id"] + ":" + config["crisp"]["key"]).encode("utf-8")
    ).decode("utf-8")
    payload = ""
    headers = {"X-Crisp-Tier": "plugin", "Authorization": "Basic " + authtier}
    response = requests.request("GET", url, headers=headers, data=payload)
    endPoint = json.loads(response.text).get("data").get("socket").get("app")
    return endPoint

# Connecting to Crisp RTM(WSS) Server
async def exec(context: ContextTypes.DEFAULT_TYPE):
    global callbackContext
    callbackContext = context
    # await sendAllUnread()
    await sio.connect(
        getCrispConnectEndpoints(),
        transports="websocket",
        wait_timeout=10,
    )
    await sio.wait()
