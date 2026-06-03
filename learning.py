import json
import logging
import os
import re
from datetime import datetime, timezone


config = {}


def setup(app_config):
    global config
    config = app_config.get("learning", {}) or {}


def is_enabled():
    return bool(config.get("enabled", True))


def get_log_path():
    return config.get("logPath") or os.getenv("LEARNING_LOG_PATH") or "data/learning_logs.jsonl"


def mask_text(value):
    if value is None:
        return None

    text = str(value)
    text = re.sub(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", "[email]", text)
    text = re.sub(r"https?://\S+", mask_url, text)
    text = re.sub(r"\b[A-Za-z0-9_-]{24,}\b", "[token]", text)
    return text


def mask_url(match):
    url = match.group(0)
    return re.sub(r"([?&](?:token|key|auth|password|passwd|pwd|access_token|sub|subscribe)=)[^&\s]+", r"\1[hidden]", url, flags=re.I)


def mask_url_text(value):
    if value is None:
        return None
    return re.sub(r"https?://\S+", mask_url, str(value))


def mask_meta(meta):
    if not isinstance(meta, dict):
        return {}

    return {
        "email": "[email]" if meta.get("email") else None,
        "plan": mask_text(meta.get("plan")),
        "expired": mask_text(meta.get("expired")),
        "traffic": mask_text(meta.get("traffic")),
    }


def log_event(event_type, session_id, content=None, meta=None, extra=None):
    if not is_enabled():
        return

    event = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "type": event_type,
        "sessionId": session_id,
        "content": mask_text(content),
        "meta": mask_meta(meta),
    }
    if extra:
        event["extra"] = {
            key: mask_url_text(value) if str(key).lower().endswith("url") else mask_text(value)
            for key, value in extra.items()
        }

    path = get_log_path()
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "a", encoding="utf-8") as file:
            file.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception as error:
        logging.warning("无法写入学习日志：%s", error)
