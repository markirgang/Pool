#!/usr/bin/env python3
"""Single-account login for the pool app.

Credentials live in config.local.json (git-ignored) under "auth":
    {"username": ..., "password_hash": "pbkdf2_sha256$<iter>$<salt>$<hash>",
     "secret": <hex>}

Sessions are stateless signed cookies (HMAC-SHA256 over user + expiry), so
they survive server restarts. Changing the password rotates the secret,
which logs out every existing session.

Set or change the password from a terminal on the Pi:
    .venv/bin/python auth.py
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import time
from typing import Any

COOKIE_NAME = "pool_session"
SESSION_SECONDS = 30 * 24 * 3600
PBKDF2_ITERATIONS = 240_000

_MAX_FAILURES = 5
_LOCKOUT_SECONDS = 60
_failures: dict[str, list[float]] = {}
_failures_lock = threading.Lock()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                 bytes.fromhex(salt), PBKDF2_ITERATIONS)
    return "pbkdf2_sha256$%d$%s$%s" % (PBKDF2_ITERATIONS, salt, digest.hex())


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt, expected = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                     bytes.fromhex(salt), int(iterations))
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(digest.hex(), expected)


def _auth_cfg(config: dict[str, Any]) -> dict[str, Any]:
    auth = config.get("auth")
    return auth if isinstance(auth, dict) else {}


def is_configured(config: dict[str, Any]) -> bool:
    auth = _auth_cfg(config)
    return bool(auth.get("username") and auth.get("password_hash") and auth.get("secret"))


def _sign(secret: str, payload: str) -> str:
    mac = hmac.new(bytes.fromhex(secret), payload.encode("utf-8"), hashlib.sha256)
    return base64.urlsafe_b64encode(mac.digest()).decode("ascii").rstrip("=")


def make_session(config: dict[str, Any]) -> str:
    auth = _auth_cfg(config)
    expires = int(time.time()) + SESSION_SECONDS
    user = base64.urlsafe_b64encode(auth["username"].encode("utf-8")).decode("ascii").rstrip("=")
    payload = "%s.%d" % (user, expires)
    return payload + "." + _sign(auth["secret"], payload)


def session_user(config: dict[str, Any], token: str | None) -> str | None:
    if not token or not is_configured(config):
        return None
    auth = _auth_cfg(config)
    try:
        user_b64, expires, signature = token.split(".")
        if int(expires) < time.time():
            return None
    except ValueError:
        return None
    payload = "%s.%s" % (user_b64, expires)
    if not hmac.compare_digest(_sign(auth["secret"], payload), signature):
        return None
    padded = user_b64 + "=" * (-len(user_b64) % 4)
    try:
        user = base64.urlsafe_b64decode(padded).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    return user if user == auth["username"] else None


def locked_out(client: str) -> bool:
    now = time.time()
    with _failures_lock:
        recent = [t for t in _failures.get(client, []) if now - t < _LOCKOUT_SECONDS]
        _failures[client] = recent
        return len(recent) >= _MAX_FAILURES


def check_login(config: dict[str, Any], client: str, username: str, password: str) -> bool:
    if not is_configured(config) or locked_out(client):
        return False
    auth = _auth_cfg(config)
    ok = hmac.compare_digest(str(username).strip().encode("utf-8"),
                             auth["username"].encode("utf-8"))
    ok = verify_password(str(password), auth["password_hash"]) and ok
    with _failures_lock:
        if ok:
            _failures.pop(client, None)
        else:
            _failures.setdefault(client, []).append(time.time())
    return ok


def _set_password_cli() -> None:
    base = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base, "config.local.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            local = json.load(fh)
    except (OSError, ValueError):
        local = {}
    current = (local.get("auth") or {}).get("username", "")
    username = input("Username [%s]: " % (current or "admin")).strip() or current or "admin"
    while True:
        password = getpass.getpass("New password (min 8 characters): ")
        if len(password) < 8:
            print("Too short, try again.")
            continue
        if password != getpass.getpass("Repeat password: "):
            print("Passwords don't match, try again.")
            continue
        break
    local["auth"] = {
        "username": username,
        "password_hash": hash_password(password),
        "secret": secrets.token_hex(32),
    }
    tmp = path + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as fh:
        json.dump(local, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    print("Saved login for '%s'. Restart the app: systemctl --user restart pool.service" % username)


if __name__ == "__main__":
    if not sys.stdin.isatty():
        sys.exit("Run this in a terminal: .venv/bin/python auth.py")
    _set_password_cli()
