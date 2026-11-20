#!/usr/bin/env python3
"""Single-account login for the pool app.

Credentials live in config.local.json (git-ignored) under "auth":
    {"users": {"admin": {"password_hash": "pbkdf2_sha256$...", "role": "admin"},
               "guest": {"password_hash": "...", "role": "guest"}},
     "secret": <hex>}

Roles: both can control the pool; only "admin" can see the camera.

Sessions are stateless signed cookies (HMAC-SHA256 over user + expiry), so
they survive server restarts. Changing the password rotates the secret,
which logs out every existing session.

Add users or change passwords from a terminal on the Pi:
    .venv/bin/python auth.py

Set or change the password needed to light the firebasket burners:
    .venv/bin/python auth.py burner
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


def users(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """{username: {"password_hash": ..., "role": "admin" | "guest"}}.

    Older configs with a single username/password_hash count as one admin.
    """
    auth = _auth_cfg(config)
    found = auth.get("users")
    if isinstance(found, dict):
        return {str(k): v for k, v in found.items() if isinstance(v, dict) and v.get("password_hash")}
    if auth.get("username") and auth.get("password_hash"):
        return {str(auth["username"]): {"password_hash": auth["password_hash"], "role": "admin"}}
    return {}


def role_of(config: dict[str, Any], username: str | None) -> str | None:
    user = users(config).get(username or "")
    return str(user.get("role") or "guest") if user else None


def is_configured(config: dict[str, Any]) -> bool:
    return bool(users(config) and _auth_cfg(config).get("secret"))


def _sign(secret: str, payload: str) -> str:
    mac = hmac.new(bytes.fromhex(secret), payload.encode("utf-8"), hashlib.sha256)
    return base64.urlsafe_b64encode(mac.digest()).decode("ascii").rstrip("=")


def make_session(config: dict[str, Any], username: str) -> str:
    auth = _auth_cfg(config)
    expires = int(time.time()) + SESSION_SECONDS
    user = base64.urlsafe_b64encode(username.encode("utf-8")).decode("ascii").rstrip("=")
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
    return user if user in users(config) else None


def kiosk_user(config: dict[str, Any], token: str | None) -> str | None:
    """User the Pi's own touchscreen signs in as, if ``token`` matches."""
    auth = _auth_cfg(config)
    expected = str(auth.get("kiosk_token") or "")
    if not token or not expected or not hmac.compare_digest(token, expected):
        return None
    user = str(auth.get("kiosk_user") or "guest")
    return user if user in users(config) else None


def locked_out(client: str) -> bool:
    now = time.time()
    with _failures_lock:
        recent = [t for t in _failures.get(client, []) if now - t < _LOCKOUT_SECONDS]
        _failures[client] = recent
        return len(recent) >= _MAX_FAILURES


def burner_password_set(config: dict[str, Any]) -> bool:
    return bool(_auth_cfg(config).get("burner_password_hash"))


def burner_locked_out() -> bool:
    return locked_out("burner-password")


def check_burner_password(config: dict[str, Any], password: Any) -> bool:
    """True if ``password`` unlocks the firebasket burners (or none is set).

    Wrong guesses share one lockout, so it can't be brute-forced quickly.
    """
    stored = _auth_cfg(config).get("burner_password_hash")
    if not stored:
        return True
    if locked_out("burner-password"):
        return False
    ok = bool(password) and verify_password(str(password).strip().lower(), stored)
    with _failures_lock:
        if ok:
            _failures.pop("burner-password", None)
        elif password:
            _failures.setdefault("burner-password", []).append(time.time())
    return ok


def check_login(config: dict[str, Any], client: str, username: str, password: str) -> str | None:
    """Return the username on success, else None (and count the failure)."""
    if not is_configured(config) or locked_out(client):
        return None
    name = str(username).strip()
    user = users(config).get(name)
    # Always run the hash so timing doesn't reveal which usernames exist.
    stored = user["password_hash"] if user else hash_password("x")
    ok = verify_password(str(password), stored) and user is not None
    with _failures_lock:
        if ok:
            _failures.pop(client, None)
        else:
            _failures.setdefault(client, []).append(time.time())
    return name if ok else None


def _set_password_cli() -> None:
    base = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base, "config.local.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            local = json.load(fh)
    except (OSError, ValueError):
        local = {}
    current = users(local)
    print("Users: %s" % (", ".join("%s (%s)" % (u, v.get("role", "guest")) for u, v in current.items()) or "none"))
    username = input("Username to add or change [admin]: ").strip() or "admin"
    default_role = (current.get(username) or {}).get("role") or ("admin" if username == "admin" else "guest")
    role = input("Role, admin or guest [%s]: " % default_role).strip().lower() or default_role
    if role not in ("admin", "guest"):
        sys.exit("Role must be admin or guest")
    while True:
        password = getpass.getpass("New password (min 8 characters): ")
        if len(password) < 8:
            print("Too short, try again.")
            continue
        if password != getpass.getpass("Repeat password: "):
            print("Passwords don't match, try again.")
            continue
        break
    current[username] = {"password_hash": hash_password(password), "role": role}
    # A new secret logs out every existing session; keep the other settings
    # (touchscreen sign-in, burner password).
    local["auth"] = {**_auth_cfg(local), "users": current, "secret": secrets.token_hex(32)}
    _save_local(path, local)
    print("Saved '%s' (%s). Restart the app: systemctl --user restart pool.service" % (username, role))


def _save_local(path: str, local: dict[str, Any]) -> None:
    tmp = path + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as fh:
        json.dump(local, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def _set_burner_password_cli() -> None:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.local.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            local = json.load(fh)
    except (OSError, ValueError):
        local = {}
    password = getpass.getpass("New burner password (blank removes it): ").strip().lower()
    auth = local.setdefault("auth", {})
    if password:
        if password != getpass.getpass("Repeat burner password: ").strip().lower():
            sys.exit("Passwords don't match")
        auth["burner_password_hash"] = hash_password(password)
    else:
        auth.pop("burner_password_hash", None)
    _save_local(path, local)
    print("Burner password %s. Restart the app: systemctl --user restart pool.service"
          % ("saved" if password else "removed"))


if __name__ == "__main__":
    if not sys.stdin.isatty():
        sys.exit("Run this in a terminal: .venv/bin/python auth.py [burner]")
    if sys.argv[1:] == ["burner"]:
        _set_burner_password_cli()
    else:
        _set_password_cli()
