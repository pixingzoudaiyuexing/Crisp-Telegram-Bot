import time


VALID_NOTIFY_MODES = {"normal", "silent"}


def normalize_notify_mode(value, default="normal"):
    mode = str(value or default).strip().lower()
    if mode not in VALID_NOTIFY_MODES:
        return default
    return mode


def set_ai(session, enabled, paused_by=None, notify_mode=None):
    session["enableAI"] = enabled
    if enabled:
        session["aiPausedBy"] = None
        session["lastOperatorReplyAt"] = None
        session["tgNotifyMode"] = "normal"
    elif paused_by == "operator":
        session["aiPausedBy"] = "operator"
        session["lastOperatorReplyAt"] = time.time()
        if notify_mode:
            session["tgNotifyMode"] = normalize_notify_mode(notify_mode)
    else:
        session["aiPausedBy"] = "manual"
        session["lastOperatorReplyAt"] = None
        if notify_mode:
            session["tgNotifyMode"] = normalize_notify_mode(notify_mode)


def maybe_auto_resume_ai(session, openai_available, auto_resume_minutes):
    if not openai_available:
        return False
    if session.get("enableAI") is True:
        return False
    if session.get("aiPausedBy") != "operator":
        return False
    if auto_resume_minutes <= 0:
        return False

    last_reply_at = session.get("lastOperatorReplyAt")
    if last_reply_at is None:
        return False
    if time.time() - last_reply_at < auto_resume_minutes * 60:
        return False

    set_ai(session, True)
    return True


def is_tg_silent(session):
    return normalize_notify_mode(session.get("tgNotifyMode"), "normal") == "silent"
