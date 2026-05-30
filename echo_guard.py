import time
from collections import defaultdict, deque


TTL_SECONDS = 300
_messages = defaultdict(deque)


def _message_key(session_id, content):
    return str(session_id), repr(content)


def record(session_id, content):
    session_id, content = _message_key(session_id, content)
    _messages[session_id].append((time.time(), content))


def consume(session_id, content):
    session_id, content = _message_key(session_id, content)
    now = time.time()
    queue = _messages.get(session_id)
    if not queue:
        return False

    while queue and now - queue[0][0] > TTL_SECONDS:
        queue.popleft()

    for index, item in enumerate(queue):
        if item[1] == content:
            del queue[index]
            return True
    return False
