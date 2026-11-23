#!/usr/bin/env python3
"""Pool - Raspberry Pi control server for a Pentair IntelliCenter.

Local URL:  http://<pi>:2490
Public URL: https://pool.shobots.party  (Cloudflare Tunnel "shobots")

Features
--------
* Pool / spa mode switching (pool is the startup default)
* Main and water-feature variable-speed pumps
* Four deck laminar jets with light and thumper
* East and west firebaskets with pool/spa spillways and spillway LEDs
* Pentair color LED pool and spa lights
* Heater and setpoint
* Main pump schedule
* Gemini voice assistant ("talk to the pool")
* Alexa Smart Home endpoint at /alexa
"""

from __future__ import annotations

import base64
import hmac
import http.cookies
import http.server
import io
import json
import logging
import re
import os
import re
import socket
import socketserver
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
from typing import Any

import alexa_custom
import auth
import ic_wiring
import voice_fast
from alexa_skill import alexa_devices_preview, handle_request as handle_alexa
from gemini_bridge import GeminiPoolBridge
from intellicenter_bridge import IntelliCenterBridge
from local_audio import LocalAudio
import local_audio
import ai_engine
import local_stt
from local_camera import LocalCamera
from pool_controller import PoolController

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
LOCAL_CONFIG_FILE = os.path.join(BASE_DIR, "config.local.json")
STATIC_DIR = os.path.join(BASE_DIR, "static")
LOG_FILE = os.path.join(BASE_DIR, "server.log")

# GET endpoints that can act on equipment; all POSTs other than login/logout
# (and /alexa, which has its own token) also need a login.
LOGIN_GET_PATHS = frozenset({
    "/api/intellicenter/open", "/api/intellicenter/host", "/intellicenter/host",
})
# The camera is admin-only: guests can control the pool but not see video.
ADMIN_GET_PATHS = frozenset({
    "/api/camera/snapshot", "/api/camera/frame", "/api/camera/stream",
})
ADMIN_POST_PATHS = frozenset({"/api/camera/look"})
BURNER_PASSWORD_REPLY = ("%s. To light them, say: light the burners, password, "
                         "and then the password.")
# Voice reply when the problem was a lockout (repeating the instructions won't help).
BURNER_LOCKED_REPLY = "%s."
# Long-lived sign-in for the Pi's own touchscreen; see auth.kiosk_user.
KIOSK_COOKIE = "pool_kiosk"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
LOG = logging.getLogger("pool.server")


def load_config() -> dict[str, Any]:
    with open(CONFIG_FILE, "r", encoding="utf-8") as fh:
        config = json.load(fh)
    try:
        with open(LOCAL_CONFIG_FILE, "r", encoding="utf-8") as fh:
            local = json.load(fh)
    except (OSError, ValueError):
        return config
    if not isinstance(local, dict):
        return config
    for key, value in local.items():
        if isinstance(value, dict) and isinstance(config.get(key), dict):
            config[key].update(value)
        else:
            config[key] = value
    return config


def save_config(config: dict[str, Any]) -> None:
    public = json.loads(json.dumps(config))
    local: dict[str, Any] = {}
    api_key = public.pop("gemini_api_key", None)
    if api_key:
        local["gemini_api_key"] = api_key
    login = public.pop("auth", None)
    if login:
        local["auth"] = login
    location = public.pop("location", None)
    if location:
        # Home coordinates stay out of the git-tracked config.json.
        local["location"] = location
    ic = public.get("intellicenter")
    if isinstance(ic, dict) and ic.get("host"):
        # Site-specific panel address stays out of the git-tracked config.json.
        local.setdefault("intellicenter", {})["host"] = ic["host"]
        ic["host"] = ""
    alexa = public.get("alexa")
    if isinstance(alexa, dict):
        token = alexa.pop("token", None)
        if token:
            local.setdefault("alexa", {})["token"] = token
    tmp = CONFIG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(public, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, CONFIG_FILE)
    if local or os.path.exists(LOCAL_CONFIG_FILE):
        tmp = LOCAL_CONFIG_FILE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with open(fd, "w", encoding="utf-8") as fh:
            json.dump(local, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, LOCAL_CONFIG_FILE)


CONFIG = load_config()
PORT = int(os.environ.get("PORT", CONFIG.get("port", 2490)))
HOST = os.environ.get("HOST", os.environ.get("IP", CONFIG.get("host", "0.0.0.0")))
DIRECTORY = os.environ.get("DIRECTORY", STATIC_DIR)

BRIDGE = IntelliCenterBridge(CONFIG)
CONTROLLER = PoolController(CONFIG, BRIDGE, save_config=save_config)
GEMINI = GeminiPoolBridge()
LOCAL_AUDIO: LocalAudio | None = None
LOCAL_CAMERA: LocalCamera | None = None
LAST_AI: dict[str, Any] = {}
LAST_AI_LOCK = threading.Lock()


def _opencode_auth() -> tuple[str, str, str]:
    """Read the first usable API key from the local OpenCode auth store."""
    candidates = (
        os.path.expanduser("~/.local/share/opencode/auth.json"),
        os.path.expanduser("~/.config/opencode/auth.json"),
    )
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                auth = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(auth, dict):
            continue
        for provider in ("opencode-go", "opencode", "google"):
            entry = auth.get(provider)
            if isinstance(entry, dict):
                key = entry.get("key") or entry.get("access") or ""
                if key:
                    return str(provider), str(key), path
        for provider, entry in auth.items():
            if isinstance(entry, dict) and entry.get("key"):
                return str(provider), str(entry["key"]), path
    return "", "", ""


def _opencode_key() -> str:
    return _opencode_auth()[1]


def _gemini_key(payload: dict[str, Any]) -> str:
    # The Pi's saved key is the app default; a key sent by a browser is used
    # only when none is saved, so a stale key stored in a browser can't
    # override it.
    return (
        CONFIG.get("gemini_api_key")
        or payload.get("api_key")
        or os.environ.get("OPENCODE_GO_API_KEY")
        or os.environ.get("OPENCODE_API_KEY")
        or os.environ.get("GEMINI_API_KEY")
        or _opencode_key()
        or ""
    )


def _key_provider(key: str) -> str:
    token = (key or "").strip()
    if not token:
        return ""
    if token.startswith("AIza"):
        return "google"
    # AQ. keys belong to the OpenCode Go account and go through its gateway,
    # not straight to Google. Sending one to Google gets "service account
    # deleted/disabled" instead of a useful error.
    return "opencode-go"


def _ai_provider(payload: dict[str, Any] | None = None) -> str:
    payload = payload or {}
    chosen = (
        payload.get("provider")
        or os.environ.get("POOL_AI_PROVIDER")
        or (CONFIG.get("ai") or {}).get("provider")
        or ""
    ).strip().lower()
    if chosen in ("google", "opencode-go", "opencode"):
        return chosen
    key = ""
    if payload.get("api_key"):
        key = str(payload["api_key"])
    elif CONFIG.get("gemini_api_key"):
        key = str(CONFIG["gemini_api_key"])
    elif os.environ.get("OPENCODE_GO_API_KEY"):
        return "opencode-go"
    elif os.environ.get("OPENCODE_API_KEY"):
        return "opencode"
    elif os.environ.get("GEMINI_API_KEY"):
        key = os.environ["GEMINI_API_KEY"]
    else:
        auth_provider, key, _ = _opencode_auth()
        if auth_provider in ("opencode-go", "opencode"):
            return auth_provider
    return _key_provider(key) or "google"


def _ai_key_hint() -> dict[str, Any]:
    key = _gemini_key({})
    auth_provider, _, auth_path = _opencode_auth()
    if CONFIG.get("gemini_api_key"):
        source = "saved settings"
    elif os.environ.get("OPENCODE_GO_API_KEY"):
        source = "OPENCODE_GO_API_KEY"
    elif os.environ.get("OPENCODE_API_KEY"):
        source = "OPENCODE_API_KEY"
    elif os.environ.get("GEMINI_API_KEY"):
        source = "GEMINI_API_KEY"
    elif auth_provider:
        source = "%s (%s)" % (auth_path, auth_provider)
    else:
        source = ""
    return {
        "configured": bool(key),
        "key_hint": ("...%s" % key[-4:]) if key else "",
        "source": source,
    }


def _decorate_state(state: dict[str, Any]) -> dict[str, Any]:
    decorated = dict(state or {})
    with LAST_AI_LOCK:
        decorated["assistant"] = dict(LAST_AI)
    decorated["audio"] = {
        "local": LOCAL_AUDIO.status() if LOCAL_AUDIO else {
            "mic_running": False, "speaker_available": False,
        }
    }
    decorated["camera"] = LOCAL_CAMERA.status() if LOCAL_CAMERA else {
        "available": False, "device": "auto",
    }
    decorated["voice_timing"] = _voice_timing()
    return decorated


# Where the time went on the most recent voice request (Voice tab, Speed card).
VOICE_TIMING: dict[str, Any] = {}
VOICE_TIMING_LOCK = threading.Lock()


def _voice_timing() -> dict[str, Any]:
    with VOICE_TIMING_LOCK:
        t = dict(VOICE_TIMING)
    if not t.get("started"):
        return {}
    start = t["started"]
    out = {"at": start, "path": t.get("path"), "engine": t.get("engine"),
           "reply_model": t.get("reply_model"), "transcript": t.get("transcript", "")}
    for key, mark in (("heard_s", "heard"), ("answered_s", "replied"), ("speaking_s", "speaking")):
        if t.get(mark):
            out[key] = round(t[mark] - start, 2)
    return out


def _mark_timing(timing: dict[str, Any] | None, **marks: Any) -> None:
    if timing is None:
        return
    with VOICE_TIMING_LOCK:
        timing.update(marks)
        if VOICE_TIMING is not timing:
            VOICE_TIMING.clear()
        VOICE_TIMING.update(timing)


def _stt_setting(assistant: dict[str, Any]) -> str:
    setting = str(assistant.get("stt_model") or local_stt.DEFAULT_MODEL)
    if local_stt.is_local(setting) and not local_stt.available():
        return voice_fast.DEFAULT_STT_MODEL
    return setting


def _state() -> dict[str, Any]:
    return _decorate_state(CONTROLLER.state())


def _apply_action(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not action:
        return {"ok": False, "message": "No action supplied"}
    if action == "status":
        return {"ok": True, "message": "Pool status", "state": _state()}
    result = CONTROLLER.command(action, payload or {})
    if isinstance(result.get("state"), dict):
        result["state"] = _decorate_state(result["state"])
    return result


def _local_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        address = sock.getsockname()[0]
        sock.close()
        return address
    except OSError:
        return ""


_LIST_CACHE: dict[str, tuple[float, Any]] = {}


def _cached(key: str, producer, seconds: float = 10.0) -> Any:
    """Device lists run several wpctl commands; reuse them for a few seconds."""
    hit = _LIST_CACHE.get(key)
    if hit and time.time() - hit[0] < seconds:
        return hit[1]
    value = producer()
    _LIST_CACHE[key] = (time.time(), value)
    return value


def _public_config() -> dict[str, Any]:
    cfg = json.loads(json.dumps(CONFIG))
    cfg.pop("gemini_api_key", None)
    cfg.pop("auth", None)
    cfg.pop("location", None)  # home coordinates; /api/config needs no login
    alexa = cfg.get("alexa") or {}
    token = alexa.pop("token", None)
    alexa["token_set"] = bool(token)
    cfg["ai"] = {
        "provider": _ai_provider({}),
        "model": GEMINI.model_for(_ai_provider({})),
        **_ai_key_hint(),
    }
    cfg["pi"] = {
        "hostname": socket.gethostname(),
        "local_ip": _local_ip(),
        "port": PORT,
        "public_url": CONFIG.get("public_url") or "",
    }
    return cfg



_TTS_CACHE = {}

VOICE_MAP = {
    'ai_butler_uk': ('en-GB-RyanNeural', 'en', 'co.uk'),
    'ai_female_uk': ('en-GB-SoniaNeural', 'en', 'co.uk'),
    'ai_male_uk': ('en-GB-RyanNeural', 'en', 'co.uk'),
    'ai_female_us': ('en-US-JennyNeural', 'en', 'com'),
    'ai_male_us': ('en-US-GuyNeural', 'en', 'us'),
    'ai_female_au': ('en-AU-NatashaNeural', 'en', 'com.au'),
    'ai_male_au': ('en-AU-WilliamMultilingualNeural', 'en', 'com.au'),
    'ai_female_ca': ('en-CA-ClaraNeural', 'en', 'ca'),
    'ai_male_ca': ('en-CA-LiamNeural', 'en', 'ca'),
    'ai_female_in': ('en-IN-NeerjaNeural', 'en', 'co.in'),
    'ai_male_in': ('en-IN-PrabhatNeural', 'en', 'co.in'),
    'ai_female_ie': ('en-IE-EmilyNeural', 'en', 'ie'),
    'ai_male_ie': ('en-IE-ConnorNeural', 'en', 'ie'),
    'ai_female_za': ('en-ZA-LeahNeural', 'en', 'co.za'),
    'ai_male_za': ('en-ZA-LukeNeural', 'en', 'co.za'),
    'ai_female_ng': ('en-NG-EzinneNeural', 'en', 'com.ng'),
    'ai_male_ng': ('en-NG-AbeoNeural', 'en', 'com.ng'),
    'ai_female_nz': ('en-NZ-MollyNeural', 'en', 'co.nz'),
    'ai_male_nz': ('en-NZ-MitchellNeural', 'en', 'co.nz'),
}

async def _gen_edge_tts(text: str, voice: str) -> bytes:
    import edge_tts
    comm = edge_tts.Communicate(text, voice)
    chunks = []
    async for c in comm.stream():
        if c['type'] == 'audio':
            chunks.append(c['data'])
    return b''.join(chunks)

def handle_tts_speak(text: str, voice_id: str = "ai_butler_uk") -> bytes:
    clean = re.sub(r'\*[^*]*\*', '', text or "Hello").strip() or "Hello"
    voice_key = str(voice_id or "ai_butler_uk").strip()
    cache_key = (clean, voice_key)
    if cache_key in _TTS_CACHE:
        return _TTS_CACHE[cache_key]

    edge_voice, lang, tld = VOICE_MAP.get(voice_key, ('en-GB-RyanNeural', 'en', 'co.uk'))
    try:
        data = asyncio.run(_gen_edge_tts(clean, edge_voice))
        if data:
            if len(_TTS_CACHE) > 64:
                _TTS_CACHE.pop(next(iter(_TTS_CACHE)))
            _TTS_CACHE[cache_key] = data
            return data
    except Exception:
        pass

    import io
    from gtts import gTTS
    mp3 = io.BytesIO()
    gTTS(text=clean, lang=lang, tld=tld).write_to_fp(mp3)
    data = mp3.getvalue()
    if len(_TTS_CACHE) > 64:
        _TTS_CACHE.pop(next(iter(_TTS_CACHE)))
    _TTS_CACHE[cache_key] = data
    return data

class PoolHandler(http.server.SimpleHTTPRequestHandler):
    server_version = "ShobotsPool/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    # ------------------------------------------------------------------
    # HTTP plumbing
    # ------------------------------------------------------------------
    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def send_json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_image(self, body: bytes | None, status: int = 200) -> None:
        if not body:
            self.send_json({"error": "Camera unavailable"}, status=503)
            return
        self.send_response(status)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def send_camera_stream(self) -> None:
        """Live MJPEG (multipart/x-mixed-replace), camera.local.stream_fps per viewer."""
        stream = LOCAL_CAMERA.stream if LOCAL_CAMERA else None
        if not stream or not stream.ensure():
            self.send_json({"error": "Camera unavailable"}, status=503)
            return
        boundary = "poolframe"
        # A small send buffer stops frames queuing up on slow links: when the
        # viewer can't keep up, older frames are skipped instead of delayed.
        try:
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 32 * 1024)
        except OSError:
            pass
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=" + boundary)
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        seq, last_sent = -1, 0.0
        camera_cfg = (CONFIG.get("camera") or {}).get("local") or {}
        interval = 1.0 / max(1.0, min(30.0, float(camera_cfg.get("stream_fps", 10))))
        try:
            while True:
                stream.ensure()
                seq, frame = stream.wait_frame(seq, timeout=5.0)
                if not frame:
                    if not stream.running():
                        break
                    continue
                wait = interval - (time.time() - last_sent)
                if wait > 0:
                    time.sleep(wait)
                    seq, frame = stream.wait_frame(seq - 1, timeout=0.5)
                self.wfile.write(("--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n"
                                  % (boundary, len(frame))).encode("ascii"))
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
                last_sent = time.time()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        self.raw_body = raw
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    def route_path(self) -> str:
        return urllib.parse.urlparse(self.path).path

    # ------------------------------------------------------------------
    # Login
    # ------------------------------------------------------------------
    def client_ip(self) -> str:
        peer = self.client_address[0]
        # The Cloudflare tunnel connects from localhost; trust its header only then.
        if peer in ("127.0.0.1", "::1"):
            return self.headers.get("CF-Connecting-IP") or peer
        return peer

    def is_https(self) -> bool:
        return (self.headers.get("X-Forwarded-Proto", "").lower() == "https"
                or '"https"' in self.headers.get("CF-Visitor", ""))

    def session_user(self) -> str | None:
        cookies = http.cookies.SimpleCookie()
        try:
            cookies.load(self.headers.get("Cookie", ""))
        except http.cookies.CookieError:
            return None
        morsel = cookies.get(auth.COOKIE_NAME)
        user = auth.session_user(CONFIG, morsel.value if morsel else None)
        if user or not self.is_local_screen():
            return user
        kiosk = cookies.get(KIOSK_COOKIE)
        return auth.kiosk_user(CONFIG, kiosk.value if kiosk else None)

    def is_local_screen(self) -> bool:
        """Browser running on the Pi itself, not a visitor through the tunnel."""
        return (self.client_address[0] in ("127.0.0.1", "::1")
                and not self.headers.get("CF-Connecting-IP")
                and not self.headers.get("CF-Ray")
                and not self.headers.get("X-Forwarded-For"))

    def handle_kiosk(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        token = query.get("token", [""])[0]
        if not self.is_local_screen() or not auth.kiosk_user(CONFIG, token):
            self.send_json({"error": "Kiosk sign-in only works on the Pi's own screen"},
                           status=403)
            return
        self.send_response(302)
        self.send_header("Set-Cookie", "%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d"
                         % (KIOSK_COOKIE, token, 10 * 365 * 24 * 3600))
        self.send_header("Location", "/?kiosk=1")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def require_login(self) -> bool:
        if self.session_user():
            return True
        message = ("Log in to view the camera or change settings"
                   if auth.is_configured(CONFIG)
                   else "No login is set up yet; run .venv/bin/python auth.py on the Pi")
        self.send_json({"error": message, "login_required": True}, status=401)
        return False

    def require_admin(self) -> bool:
        if not self.require_login():
            return False
        if auth.role_of(CONFIG, self.session_user()) == "admin":
            return True
        self.send_json({"error": "Only the admin account can view the camera",
                        "admin_required": True}, status=403)
        return False

    def set_session_cookie(self, value: str, max_age: int) -> None:
        cookie = "%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d" % (
            auth.COOKIE_NAME, value, max_age)
        if self.is_https():
            cookie += "; Secure"
        self.send_header("Set-Cookie", cookie)

    def handle_login(self, data: dict[str, Any]) -> None:
        client = self.client_ip()
        if not auth.is_configured(CONFIG):
            self.send_json({"error": "No login is set up yet; run .venv/bin/python auth.py on the Pi"},
                           status=503)
            return
        if auth.locked_out(client):
            self.send_json({"error": "Too many failed attempts; wait a minute and try again"},
                           status=429)
            return
        user = auth.check_login(CONFIG, client, data.get("username", ""), data.get("password", ""))
        if not user:
            LOG.warning("Failed login from %s", client)
            self.send_json({"error": "Wrong username or password"}, status=401)
            return
        role = auth.role_of(CONFIG, user)
        LOG.info("Login by %s (%s) from %s", user, role, client)
        body = json.dumps({"ok": True, "username": user, "role": role}).encode("utf-8")
        self.send_response(200)
        self.set_session_cookie(auth.make_session(CONFIG, user), auth.SESSION_SECONDS)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_logout(self) -> None:
        body = b'{"ok": true}'
        self.send_response(200)
        self.set_session_cookie("", 0)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------------
    # GET
    # ------------------------------------------------------------------
    def do_HEAD(self):
        path = self.route_path()
        if (path in LOGIN_GET_PATHS and not self.session_user()) or (
                path in ADMIN_GET_PATHS and auth.role_of(CONFIG, self.session_user()) != "admin"):
            self.send_response(401)
            self.end_headers()
            return
        if path in ("/api/camera/snapshot", "/api/camera/frame"):
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
        elif path.startswith("/api/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
        else:
            super().do_HEAD()

    def do_GET(self):
        path = self.route_path()
        if path in LOGIN_GET_PATHS and not self.require_login():
            return
        if path in ADMIN_GET_PATHS and not self.require_admin():
            return
        if path == "/kiosk":
            self.handle_kiosk()
            return
        if path == "/api/auth":
            user = self.session_user()
            self.send_json({"configured": auth.is_configured(CONFIG),
                            "logged_in": bool(user), "username": user,
                            "role": auth.role_of(CONFIG, user)})
        elif path == "/api/camera/stream":
            self.send_camera_stream()
        elif path == "/api/state":
            self.send_json(_state())
        elif path == "/api/status":
            self.send_json({
                "ok": True,
                "name": CONFIG.get("name", "Pool"),
                "public_url": CONFIG.get("public_url"),
                "port": PORT,
                "host": HOST,
                "time": time.time(),
                "connection": BRIDGE.status(),
                "audio": LOCAL_AUDIO.status() if LOCAL_AUDIO else None,
                "camera": LOCAL_CAMERA.status() if LOCAL_CAMERA else None,
                "schedule": _state().get("schedule"),
            })
        elif path in ("/api/inventory", "/api/intellicenter/devices"):
            self.send_json({
                "ok": True,
                "connection": BRIDGE.status(),
                "inventory": BRIDGE.inventory(),
                "resolved": BRIDGE.resolved(),
                "mapping": CONFIG.get("devices", {}),
                "custom_devices": CONFIG.get("custom_devices", []),
            })
        elif path in ("/api/intellicenter/open", "/api/intellicenter/host", "/intellicenter/host"):
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            redirect = (
                path == "/intellicenter/host"
                or query.get("redirect", [""])[0].lower() in ("1", "true", "yes")
            )
            launch = query.get("launch", [""])[0].lower() in ("1", "true", "yes")
            result = CONTROLLER.open_host_page(launch_browser=launch)
            if redirect:
                if result.get("ok") and result.get("url"):
                    self.send_response(307)
                    self.send_header("Location", result["url"])
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    return
                body = (
                    "<!DOCTYPE html><html><head><meta charset='utf-8'>"
                    "<title>IntelliCenter Host Not Found</title></head>"
                    "<body style='font-family:system-ui,sans-serif;background:#071924;color:#e8f7fb;padding:40px;text-align:center;'>"
                    "<h2>Pentair IntelliCenter Host Not Found</h2>"
                    "<p>No IntelliCenter host or IP address is currently configured or discovered on the network.</p>"
                    "<p><a href='/' style='color:#43e1e8;font-weight:bold;'>Return to Pool Dashboard</a></p>"
                    "</body></html>"
                ).encode("utf-8")
                self.send_response(404)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_json(result, status=200 if result.get("ok") else 404)
        elif path in ("/api/intellicenter/scan", "/api/scan"):
            self.send_json(CONTROLLER.scan_status())
        elif path == "/api/intellicenter/wiring":
            report = ic_wiring.build(BRIDGE.inventory(), BRIDGE.resolved(), BRIDGE.status())
            self.send_json({"ok": True, "report": report, "html": ic_wiring.render_tables(report)})
        elif path == "/intellicenter/wiring":
            report = ic_wiring.build(BRIDGE.inventory(), BRIDGE.resolved(), BRIDGE.status())
            body = ic_wiring.render_page(report, CONFIG.get("name") or "Lighthouse Pool").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/config":
            self.send_json(_public_config())
        elif path in ("/api/models", "/api/ai/models"):
            self.send_json(ai_engine.get_available_models())
        elif path in ("/api/audio/inputs", "/api/audio/sources"):
            self.send_json({"inputs": _cached("inputs", local_audio.list_local_audio_inputs)})
        elif path in ("/api/audio/outputs", "/api/audio/sinks"):
            self.send_json({"outputs": _cached("outputs", local_audio.list_local_audio_outputs)})
        elif path.startswith("/api/tts/speak"):
            query_params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            text_to_speak = query_params.get("text", ["Hello!"])[0]
            voice_id = query_params.get("voice", ["ai_butler_uk"])[0]
            try:
                audio_bytes = local_audio.synthesize_voice(text_to_speak, voice_id)
                self.send_response(200)
                self.send_header('Content-Type', 'audio/mpeg')
                self.send_header('Content-Length', str(len(audio_bytes)))
                self.end_headers()
                self.wfile.write(audio_bytes)
            except Exception as e:
                self.send_json({"error": str(e)}, status=500)
        elif path == "/api/audio/devices":
            self.send_json(LOCAL_AUDIO.devices() if LOCAL_AUDIO else {
                "inputs": [], "outputs": [], "voices": [], "local": None,
            })
        elif path == "/api/audio/status":
            status = dict(LOCAL_AUDIO.status()) if LOCAL_AUDIO else {}
            status["ai_ok"], status["ai_error"] = AI_STATUS["ok"], AI_STATUS["error"]
            self.send_json(status)
        elif path == "/api/camera/devices":
            self.send_json({
                "cameras": LOCAL_CAMERA.devices() if LOCAL_CAMERA else [],
                "status": LOCAL_CAMERA.status() if LOCAL_CAMERA else None,
            })
        elif path == "/api/camera/frame":
            # Live view polls this: newest small frame from the shared stream.
            self.send_image(LOCAL_CAMERA.stream.frame() if LOCAL_CAMERA else None)
        elif path == "/api/camera/snapshot":
            self.send_image(LOCAL_CAMERA.capture() if LOCAL_CAMERA else None)
        elif path == "/api/alexa":
            self.send_json(alexa_devices_preview(CONTROLLER))
        elif path == "/api/alexa/interaction-model":
            alexa_cfg = CONFIG.get("alexa") or {}
            self.send_json(alexa_custom.interaction_model(
                alexa_cfg.get("invocation_name") or "lighthouse pool"))
        elif path == "/api/health":
            self.send_json({"ok": True, "time": time.time()})
        elif path in ("/", ""):
            self.path = "/index.html"
            super().do_GET()
        else:
            super().do_GET()

    # ------------------------------------------------------------------
    # POST
    # ------------------------------------------------------------------
    def do_POST(self):
        path = self.route_path()
        data = self.read_json()

        if path == "/api/login":
            self.handle_login(data)
            return
        if path == "/api/logout":
            self.handle_logout()
            return

        if path == "/alexa" and alexa_custom.is_custom_skill_request(data):
            # Custom skill: Amazon signs every request; only our Skill ID may act.
            alexa_cfg = CONFIG.get("alexa") or {}
            ok, why = alexa_custom.verify_request(
                getattr(self, "raw_body", b""), self.headers, data,
                str(alexa_cfg.get("skill_id") or "").strip())
            if not ok:
                LOG.warning("Rejected Alexa request: %s", why)
                self.send_json({"error": "unauthorized"}, status=401)
                return
            LOG.info("Alexa %s %s", (data.get("request") or {}).get("type"),
                     ((data.get("request") or {}).get("intent") or {}).get("name", ""))
            self.send_json(alexa_custom.handle(
                data, CONTROLLER, ask_iggy=_alexa_ask_iggy,
                skill_name=alexa_cfg.get("skill_name") or "Lighthouse Pool"))
            return

        if path == "/alexa":
            # Smart Home directives authenticate with a bearer token; with no
            # token set the endpoint stays closed rather than open to the internet.
            token = (CONFIG.get("alexa") or {}).get("token")
            header = self.headers.get("Authorization", "")
            if not token or not hmac.compare_digest(
                    header.removeprefix("Bearer ").encode("utf-8"), token.encode("utf-8")):
                self.send_json({"error": "unauthorized"}, status=401)
                return
            try:
                self.send_json(handle_alexa(data, CONTROLLER))
            except Exception as exc:
                LOG.exception("Alexa directive failed")
                self.send_json({
                    "event": {
                        "header": {
                            "namespace": "Alexa", "name": "ErrorResponse",
                            "payloadVersion": "3", "messageId": "pool-error",
                        },
                        "payload": {"type": "INTERNAL_ERROR", "message": str(exc)},
                    }
                }, status=200)
            return

        # Everything else changes equipment or settings.
        if not self.require_login():
            return
        if path in ADMIN_POST_PATHS and not self.require_admin():
            return

        if path == "/api/kiosk/exit":
            # Only the Pi's own screen may close its kiosk browser.
            if not self.is_local_screen():
                self.send_json({"ok": False, "message": "Exit Kiosk only works on the Pi's own screen"},
                               status=403)
                return
            script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kiosk", "kiosk-mode.sh")
            env = dict(os.environ)
            env.setdefault("WAYLAND_DISPLAY", "wayland-0")
            env.setdefault("XDG_RUNTIME_DIR", "/run/user/%d" % os.getuid())
            # Detached: the script closes the browser that sent this request.
            subprocess.Popen([script, "exit"], env=env, start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            LOG.info("Exit Kiosk pressed on the Pi screen")
            self.send_json({"ok": True, "message": "Leaving kiosk mode"})
            return

        if path == "/api/command":
            result = _apply_action(
                data.get("action", ""), data.get("payload") or data.get("params") or {}
            )
            self.send_json(result)
            return

        if path == "/api/intellicenter/device/control":
            res = CONTROLLER.command("ic_set_device", data)
            self.send_json(res)
            return

        if path == "/api/intellicenter/device/edit":
            res = CONTROLLER.command("ic_edit_device", data)
            self.send_json(res)
            return

        if path == "/api/intellicenter/device/add":
            res = CONTROLLER.command("ic_add_device", data)
            self.send_json(res)
            return

        if path == "/api/intellicenter/device/delete":
            res = CONTROLLER.command("ic_delete_device", data)
            self.send_json(res)
            return

        if path == "/api/intellicenter/mapping":
            res = CONTROLLER.command("save_animation_mapping", data)
            self.send_json(res)
            return

        if path in ("/api/intellicenter/scan", "/api/scan"):
            force = bool(data.get("force", True))
            res = CONTROLLER.scan_and_adjust(reason="user_request", force=force)
            self.send_json(res)
            return

        if path == "/api/intellicenter/chlorinator":
            res = CONTROLLER.command("ic_set_chlorinator", data)
            self.send_json(res)
            return

        if path == "/api/intellicenter/valve":
            res = CONTROLLER.command("ic_set_valve", data)
            self.send_json(res)
            return

        if path == "/api/intellicenter/schedule":
            res = CONTROLLER.set_schedule(enabled=data.get("enabled"), runs=data.get("runs"))
            self.send_json(res)
            return

        if path == "/api/intellicenter/open":
            launch = bool(data.get("launch") or data.get("browser"))
            res = CONTROLLER.open_host_page(launch_browser=launch)
            self.send_json(res, status=200 if res.get("ok") else 400)
            return

        if path == "/api/settings":
            self._update_settings(data)
            return

        if path == "/api/config":
            self._update_config(data)
            return

        if path in ("/api/gemini/chat", "/api/gemini/voice", "/api/gemini/vision"):
            self._handle_gemini(path, data)
            return

        if path == "/api/camera/look":
            prompt = data.get("prompt") or "Look at what is being shown to you and tell me what you see."
            image = LOCAL_CAMERA.capture() if LOCAL_CAMERA else None
            if not image:
                error = LOCAL_CAMERA.status().get("last_error") if LOCAL_CAMERA else "No camera"
                self.send_json({"ok": False, "text": "I can't see anything: " + str(error)}, status=503)
                return
            result = _gemini_call(
                _gemini_key(data), prompt, image_bytes=image, image_mime="image/jpeg",
                provider=_ai_provider(data),
                speaker={"browser": "browser", "pi": "pi", "local": "pi"}.get(
                    str(data.get("speaker_dest") or "")),
            )
            self.send_json(result)
            return

        self.send_json({"error": "Endpoint not found"}, status=404)

    # ------------------------------------------------------------------
    # Settings / config
    # ------------------------------------------------------------------
    def _update_settings(self, data: dict[str, Any]) -> None:
        ic = CONFIG.setdefault("intellicenter", {})
        ic_changed = False
        if "intellicenter_host" in data:
            ic["host"] = str(data.get("intellicenter_host") or "").strip()
            ic_changed = True
        if "intellicenter_port" in data:
            try:
                ic["port"] = int(data["intellicenter_port"])
                ic_changed = True
            except (TypeError, ValueError):
                pass
        if "transport" in data and data["transport"] in ("tcp", "websocket"):
            ic["transport"] = data["transport"]
            ic_changed = True
        if data.get("discovery") is not None:
            ic["discovery"] = bool(data.get("discovery"))
            ic_changed = True
        if data.get("apply_pool_mode_on_start") is not None:
            ic["apply_pool_mode_on_start"] = bool(data.get("apply_pool_mode_on_start"))
            ic_changed = True
        if data.get("timezone"):
            CONFIG["timezone"] = str(data["timezone"])
        if "gemini_api_key" in data and data.get("gemini_api_key") is not None:
            CONFIG["gemini_api_key"] = str(data.get("gemini_api_key") or "").strip()
        if data.get("ai_provider") in ("auto", "google", "opencode-go", "opencode"):
            ai = CONFIG.setdefault("ai", {})
            if data["ai_provider"] == "auto":
                ai.pop("provider", None)
            else:
                ai["provider"] = data["ai_provider"]
        if data.get("alexa_enabled") is not None:
            CONFIG.setdefault("alexa", {})["enabled"] = bool(data.get("alexa_enabled"))
        if data.get("alexa_skill_name") is not None:
            CONFIG.setdefault("alexa", {})["skill_name"] = str(data.get("alexa_skill_name") or "")
        if data.get("alexa_skill_id") is not None:
            CONFIG.setdefault("alexa", {})["skill_id"] = str(data.get("alexa_skill_id") or "").strip()
        if data.get("alexa_token") is not None:
            CONFIG.setdefault("alexa", {})["token"] = str(data.get("alexa_token") or "")
        if isinstance(data.get("assistant"), dict):
            CONFIG.setdefault("assistant", {}).update(data["assistant"])
        if isinstance(data.get("audio"), dict):
            audio = CONFIG.setdefault("audio", {})
            for section in ("local", "browser"):
                incoming = data["audio"].get(section)
                if isinstance(incoming, dict):
                    audio.setdefault(section, {}).update(incoming)
        if isinstance(data.get("camera"), dict):
            camera = CONFIG.setdefault("camera", {})
            for section in ("local", "browser"):
                incoming = data["camera"].get(section)
                if isinstance(incoming, dict):
                    camera.setdefault(section, {}).update(incoming)
        save_config(CONFIG)
        if LOCAL_AUDIO:
            LOCAL_AUDIO.reconfigure()
            _prewarm_voice_async()
        if isinstance(data.get("assistant"), dict) and "stt_model" in data["assistant"]:
            local_stt.preload(_stt_setting(CONFIG.get("assistant") or {}))
        if LOCAL_CAMERA:
            LOCAL_CAMERA.reconfigure()
        if ic_changed:
            BRIDGE.reconfigure(ic.get("host", ""), ic.get("port", 6681),
                               ic.get("transport", "tcp"))
        self.send_json({
            "ok": True,
            "message": "Settings saved" + ("; reconnecting to IntelliCenter" if ic_changed else ""),
            "config": _public_config(),
            "connection": BRIDGE.status(),
            "state": _state(),
        })

    def _update_config(self, data: dict[str, Any]) -> None:
        mapping_changed = False
        if isinstance(data.get("devices"), dict):
            CONFIG["devices"] = data["devices"]
            mapping_changed = True
        if isinstance(data.get("defaults"), dict):
            CONFIG.setdefault("defaults", {}).update(data["defaults"])
        if isinstance(data.get("schedule"), dict):
            CONFIG.setdefault("schedule", {}).update(data["schedule"])
        if data.get("timezone"):
            CONFIG["timezone"] = str(data["timezone"])
        save_config(CONFIG)
        if mapping_changed:
            BRIDGE.remap()
        self.send_json({
            "ok": True,
            "message": "Configuration saved",
            "config": _public_config(),
            "state": CONTROLLER.state(),
        })

    # ------------------------------------------------------------------
    # Gemini
    # ------------------------------------------------------------------
    def _handle_gemini(self, path: str, data: dict[str, Any]) -> None:
        api_key = _gemini_key(data)
        provider = data.get("provider") or _ai_provider(data)
        model = data.get("model", "")
        ollama_url = data.get("ollama_url", "")
        # The asking browser's own speaker choice (it may differ from the Pi's).
        speaker = {"browser": "browser", "pi": "pi", "local": "pi"}.get(str(data.get("speaker_dest") or ""))
        if path == "/api/gemini/chat":
            result = _gemini_call(api_key, data.get("prompt", ""), provider=provider, model=model,
                                  ollama_url=ollama_url, speaker=speaker)
        elif path == "/api/gemini/vision":
            image_b64 = data.get("image_b64", "")
            image = base64.b64decode(image_b64) if image_b64 else None
            result = _gemini_call(
                api_key,
                data.get("prompt") or "Look at what I am showing you and tell me what you see.",
                image_bytes=image,
                image_mime=data.get("mime_type", "image/jpeg"),
                provider=provider,
                model=model,
                ollama_url=ollama_url,
                speaker=speaker,
            )
        else:
            use_local_mic = bool(data.get("use_local_mic") or data.get("source") == "local")
            audio_b64 = data.get("audio_b64", "")
            mime = data.get("mime_type", "audio/webm")
            if use_local_mic and not audio_b64:
                audio = local_audio.record_local_audio(duration=float(data.get("duration", 3.5)), device=data.get("mic_device", "default"))
                mime = "audio/wav"
            else:
                audio = base64.b64decode(audio_b64) if audio_b64 else None
            result = _voice_request(api_key, audio, mime, local=use_local_mic, provider=provider,
                                    speaker=speaker)
        self.send_json(result)


def _alexa_ask_iggy(query: str) -> str:
    api_key = _gemini_key({})
    if not api_key:
        return "Iggy needs an AI key before he can answer."
    result = _gemini_call(api_key, query, speak_local=False, provider=_ai_provider({}))
    text = str(result.get("text") or "").strip()
    applied = result.get("applied") or {}
    if not text and applied.get("message"):
        text = str(applied["message"])
    return text


# "eggy"/"eggie"/"yagi" are how on-Pi Whisper sometimes hears "Iggy".
WAKE_WORDS = ("iggy", "iggie", "iggi", "iggey", "igy", "ziggy", "iggys", "eggy", "eggie", "yagi")


def _has_wake_word(transcription: Any) -> bool:
    """True when "Iggy" (or a common mis-hearing) appears anywhere in it."""
    words = re.findall(r"[a-z']+", str(transcription or "").lower())
    return any(w.strip("'").removesuffix("'s") in WAKE_WORDS for w in words)


AI_STATUS: dict[str, Any] = {"ok": True, "error": "", "at": 0.0}


def _ai_error_text(message: str) -> str:
    if re.search(r"credits|402", message, re.I):
        return "The AI account is out of credits. Top it up or add a new key in the Hardware tab."
    return "The AI key was rejected (disabled or deleted). Add a new key in the Hardware tab."


def _prewarm_voice_async() -> None:
    """Pre-generate speech for the instant-command replies so they play at once."""
    def run() -> None:
        voice = (CONFIG.get("assistant") or {}).get("server_voice") or local_audio.DEFAULT_SERVER_VOICE
        started = time.time()
        for text in voice_fast.common_replies():
            if LOCAL_AUDIO:
                LOCAL_AUDIO.synthesize(text, voice)
        LOG.info("Pre-generated %d instant replies in voice %s (%.0fs)",
                 len(voice_fast.common_replies()), voice, time.time() - started)
    threading.Thread(target=run, name="voice-prewarm", daemon=True).start()


def _prewarm_ai_async() -> None:
    """Load the on-Pi speech model and open the AI connection before anyone talks."""
    local_stt.preload(_stt_setting(CONFIG.get("assistant") or {}))
    threading.Thread(target=lambda: ai_engine.warm_up(_gemini_key({}), _ai_provider({})),
                     name="ai-warmup", daemon=True).start()


def _apply_voice_action(action: str | None, payload: dict[str, Any]) -> dict[str, Any]:
    """Run an instant voice command; a few expand to several panel commands."""
    if not action:
        return {"ok": True}
    if action == "set_all_jets":
        results = [_apply_action("set_deck_jet", {"id": jet, "on": payload.get("on")})
                   for jet in ("ne", "nw", "se", "sw")]
    elif action == "set_all_firebaskets":
        on = payload.get("on")
        results = [_apply_action("set_firebasket", {"id": basket, "water": on, "spa_water": on})
                   for basket in ("east", "west")]
    else:
        return _apply_action(action, payload)
    failed = [r for r in results if not r.get("ok")]
    return failed[0] if failed else results[-1]


def _voice_request(api_key: str, audio: bytes | None, mime_type: str, local: bool,
                   provider: str = "", speak_local: bool = True,
                   speaker: str | None = None) -> dict[str, Any]:
    """Fast voice path: quick transcription, wake word, instant commands, then AI."""
    started = time.time()
    assistant = CONFIG.get("assistant") or {}
    if not audio:
        return {"text": "I didn't hear anything.", "state": _state()}
    stt_setting = _stt_setting(assistant)
    timing: dict[str, Any] = {"started": started, "engine": stt_setting}
    transcript = None
    if local_stt.is_local(stt_setting):
        try:
            transcript = local_stt.transcribe(audio, mime_type, stt_setting)
        except Exception as exc:
            LOG.warning("On-Pi speech recognition failed (%s); using the cloud", exc)
            stt_setting = timing["engine"] = voice_fast.DEFAULT_STT_MODEL
    try:
        if transcript is None:
            transcript = voice_fast.transcribe(
                api_key, audio, mime_type, model=stt_setting, provider=provider)
    except Exception as exc:
        message = str(exc)
        if re.search(r"429|RESOURCE_EXHAUSTED|quota|rate.?limit", message, re.I):
            # The key is fine; the provider's allowance is temporarily used up.
            AI_STATUS.update({"ok": False,
                              "error": "The AI provider's request allowance is used up for now. Wait a few minutes and try again.",
                              "at": time.time()})
            LOG.warning("AI rate limited: %s", message[:160])
            return {"text": "", "ignored": True, "state": _state(), "transcription": "",
                    "ai_error": AI_STATUS["error"]}
        if re.search(r"401|403|UNAUTHENTICATED|PERMISSION_DENIED|API key|credits|disabled|deleted|invalid credential", message, re.I):
            # The key itself is rejected: the full model would fail the same way.
            AI_STATUS.update({"ok": False, "error": _ai_error_text(message), "at": time.time()})
            LOG.warning("AI key rejected; voice requests can't be understood: %s", message[:160])
            return {"text": "", "ignored": True, "state": _state(), "transcription": "",
                    "ai_error": AI_STATUS["error"]}
        # Fall back to the original single multimodal call.
        LOG.warning("Fast transcription failed (%s); using the full voice model", exc)
        image = None
        camera_cfg = (CONFIG.get("camera") or {}).get("local") or {}
        if local and LOCAL_CAMERA and camera_cfg.get("vision_on_voice", True):
            image = LOCAL_CAMERA.capture()
        return _gemini_call(api_key, "", audio, mime_type, local=local, speak_local=speak_local,
                            image_bytes=image, provider=provider, speaker=speaker)
    heard = time.time()
    AI_STATUS.update({"ok": True, "error": "", "at": time.time()})
    timing.update(heard=heard, transcript=transcript or "")
    if not transcript:
        return {"text": "", "ignored": True, "state": _state(), "transcription": ""}
    if local and not _has_wake_word(transcript):
        LOG.info("Local mic: ignored speech without wake word: %r", transcript[:120])
        return {"text": "", "ignored": True, "state": _state(), "transcription": transcript}
    # Speak only when spoken to: a bare "Iggy" (often noise misheard as his
    # name) or Iggy's own reply picked up from the speaker gets no answer.
    with LAST_AI_LOCK:
        last_text, last_at = str(LAST_AI.get("text") or ""), float(LAST_AI.get("at") or 0)
    if local and voice_fast.is_only_wake_word(transcript):
        LOG.info("Local mic: ignored wake word with no request: %r", transcript[:60])
        return {"text": "", "ignored": True, "state": _state(), "transcription": transcript}
    if local and time.time() - last_at < 30 and voice_fast.is_echo(transcript, last_text):
        LOG.info("Local mic: ignored Iggy's own reply heard from the speaker: %r", transcript[:80])
        return {"text": "", "ignored": True, "state": _state(), "transcription": transcript}

    fast = voice_fast.match_command(transcript, _state())
    if fast:
        action, payload, reply = fast
        applied = _apply_voice_action(action, payload)
        if applied.get("password_required"):
            text = (BURNER_LOCKED_REPLY if applied.get("locked_out")
                    else BURNER_PASSWORD_REPLY) % applied.get("message")
        else:
            text = reply if applied.get("ok") else "Sorry, that didn't work: %s" % applied.get("message")
        result: dict[str, Any] = {"text": text, "transcription": transcript, "fast": True,
                                  "applied": {"ok": applied.get("ok"), "message": applied.get("message")}}
        timing["path"] = "instant"
        _finish_reply(result, text, local, speak_local, assistant, timing, speaker)
        LOG.info("Voice (instant, %s) heard in %.1fs, answered in %.1fs: %r -> %r",
                 timing["engine"], heard - started, time.time() - started, transcript, text)
        return result

    image = None
    camera_cfg = (CONFIG.get("camera") or {}).get("local") or {}
    if local and LOCAL_CAMERA and camera_cfg.get("vision_on_voice", True) \
            and voice_fast.wants_vision(transcript):
        image = LOCAL_CAMERA.capture()
    prompt = transcript + "\n\n(Spoken request: reply in one or two short sentences that sound natural read aloud.)"
    # Only gemini-4-argon accepts images on the OpenCode gateway; the
    # faster text-only reply model would reject "Iggy, look..." requests.
    reply_model = assistant.get("reply_model") or voice_fast.DEFAULT_REPLY_MODEL
    if image is not None and provider == "opencode-go":
        reply_model = "gemini-4-argon"
    timing.update(path="AI", reply_model=reply_model)
    result = _gemini_call(
        api_key, prompt, local=local, speak_local=speak_local, image_bytes=image,
        provider=provider, model=reply_model,
        transcription=transcript, timing=timing, speaker=speaker)
    LOG.info("Voice (AI, %s + %s) heard in %.1fs, answered in %.1fs: %r", timing["engine"],
             reply_model, heard - started, time.time() - started, transcript)
    return result


def _finish_reply(result: dict[str, Any], text: str, local: bool, speak_local: bool,
                  assistant: dict[str, Any], timing: dict[str, Any] | None = None,
                  speaker: str | None = None) -> None:
    """Record the reply for the app and speak it on the selected speaker."""
    _mark_timing(timing, replied=time.time())
    result["state"] = _state()
    result["at"] = time.time()
    with LAST_AI_LOCK:
        LAST_AI.clear()
        LAST_AI.update({
            "text": text,
            "at": result["at"],
            "source": "local-microphone" if local else "browser",
            "transcription": result.get("transcription") or "",
        })
    if text and LOCAL_AUDIO:
        voice = assistant.get("server_voice") or local_audio.DEFAULT_SERVER_VOICE
        # One speaker at a time: the Pi's or the browser's (Hardware tab). A
        # browser request names its own choice; otherwise the Pi's setting wins.
        use_pi = speaker == "pi" if speaker else LOCAL_AUDIO.pi_speaker_selected()
        if use_pi:
            if speak_local:
                # Starts talking as the voice streams in; the browser plays nothing.
                LOCAL_AUDIO.speak(text, voice,
                                  on_start=lambda: _mark_timing(timing, speaking=time.time()))
        else:
            data, audio_mime = LOCAL_AUDIO.synthesize(text, voice)
            if data:
                result["audio_b64"] = base64.b64encode(data).decode("ascii")
                result["audio_mime"] = audio_mime
                _mark_timing(timing, speaking=time.time())


def _gemini_call(api_key: str, prompt: str = "", audio: bytes | None = None,
                 mime_type: str = "audio/webm", local: bool = False,
                 speak_local: bool = True,
                 image_bytes: bytes | None = None,
                 image_mime: str = "image/jpeg",
                 provider: str = "google",
                 model: str = "",
                 ollama_url: str = "",
                 transcription: str | None = None,
                 timing: dict[str, Any] | None = None,
                 speaker: str | None = None) -> dict[str, Any]:
    assistant = CONFIG.get("assistant") or {}
    state = _state()
    if audio is not None:
        result = GEMINI.generate_voice_chat_response(
            api_key, audio, mime_type, state, assistant, local,
            image_bytes, image_mime, provider, model, ollama_url
        )
    else:
        result = GEMINI.generate_chat_response(
            api_key, prompt, state, assistant, image_bytes, image_mime, provider, model, ollama_url
        )
    if transcription is not None:
        result["transcription"] = transcription
    text = str(result.get("text") or "").strip()
    if local and not _has_wake_word(result.get("transcription")):
        # The always-on mic hears everything; only act on speech addressed
        # to Iggy so background talk can't switch equipment.
        LOG.info("Local mic: ignored speech without wake word: %r",
                 (result.get("transcription") or "")[:120])
        return {"text": "", "ignored": True, "state": state,
                "transcription": result.get("transcription") or ""}
    if text.upper().startswith("IGNORE"):
        result["text"] = ""
        result["ignored"] = True
        result["state"] = state
        return result
    action = result.get("action")
    if action:
        applied = _apply_action(action.get("action"), action.get("payload") or {})
        result["applied"] = {
            "ok": applied.get("ok"),
            "message": applied.get("message"),
        }
        if applied.get("password_required"):
            text = result["text"] = (BURNER_LOCKED_REPLY if applied.get("locked_out")
                                     else BURNER_PASSWORD_REPLY) % applied.get("message")
        elif not text or text.startswith("Executing action:"):
            # The model acted without saying anything; say what was done.
            text = result["text"] = str(applied.get("message") or "Done.")
    _finish_reply(result, text, local, speak_local, assistant, timing, speaker)
    return result


def _local_audio_request(audio: bytes, mime_type: str) -> dict[str, Any] | None:
    api_key = _gemini_key({})
    if not api_key:
        return None
    return _voice_request(api_key, audio, mime_type, local=True, provider=_ai_provider({}))


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _find_cert():
    cert = os.path.join(BASE_DIR, "cert.pem")
    key = os.path.join(BASE_DIR, "key.pem")
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    return None, None


def main() -> None:
    global LOCAL_AUDIO, LOCAL_CAMERA
    LOCAL_AUDIO = LocalAudio(
        CONFIG, lambda: _gemini_key({}), _local_audio_request
    )
    LOCAL_CAMERA = LocalCamera(CONFIG)
    LOCAL_CAMERA.pixy.start()
    LOCAL_AUDIO.start()
    _prewarm_voice_async()
    _prewarm_ai_async()
    BRIDGE.start()
    CONTROLLER.start()
    httpd = ThreadingHTTPServer((HOST, PORT), PoolHandler)
    cert, key = _find_cert()
    scheme = "http"
    if cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"
    LOG.info("Pool control server ready on %s://%s:%s", scheme, HOST, PORT)
    LOG.info("IntelliCenter mode: %s", BRIDGE.mode)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        LOG.info("Shutting down")
    finally:
        CONTROLLER.stop()
        BRIDGE.stop()
        if LOCAL_CAMERA:
            LOCAL_CAMERA.pixy.stop()
        if LOCAL_AUDIO:
            LOCAL_AUDIO.stop()
        httpd.server_close()


if __name__ == "__main__":
    main()
