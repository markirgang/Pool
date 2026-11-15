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
import http.server
import json
import logging
import os
import socket
import socketserver
import ssl
import sys
import threading
import time
import urllib.parse
from typing import Any

from alexa_skill import alexa_devices_preview, handle_request as handle_alexa
from gemini_bridge import GeminiPoolBridge
from intellicenter_bridge import IntelliCenterBridge
from local_audio import LocalAudio
import local_audio
import ai_engine
from local_camera import LocalCamera
from pool_controller import PoolController

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
LOCAL_CONFIG_FILE = os.path.join(BASE_DIR, "config.local.json")
STATIC_DIR = os.path.join(BASE_DIR, "static")
LOG_FILE = os.path.join(BASE_DIR, "server.log")

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
        with open(tmp, "w", encoding="utf-8") as fh:
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
    return (
        payload.get("api_key")
        or CONFIG.get("gemini_api_key")
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
    if token.startswith(("AIza", "AQ.")):
        return "google"
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
    return decorated


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


def _public_config() -> dict[str, Any]:
    cfg = json.loads(json.dumps(CONFIG))
    cfg.pop("gemini_api_key", None)
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

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    def route_path(self) -> str:
        return urllib.parse.urlparse(self.path).path

    # ------------------------------------------------------------------
    # GET
    # ------------------------------------------------------------------
    def do_HEAD(self):
        if self.route_path().startswith("/api/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
        else:
            super().do_HEAD()

    def do_GET(self):
        path = self.route_path()
        if path == "/api/state":
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
        elif path == "/api/config":
            self.send_json(_public_config())
        elif path in ("/api/models", "/api/ai/models"):
            self.send_json(ai_engine.get_available_models())
        elif path in ("/api/audio/inputs", "/api/audio/sources"):
            self.send_json({"inputs": local_audio.list_local_audio_inputs()})
        elif path in ("/api/audio/outputs", "/api/audio/sinks"):
            self.send_json({"outputs": local_audio.list_local_audio_outputs()})
        elif path == "/api/audio/devices":
            self.send_json(LOCAL_AUDIO.devices() if LOCAL_AUDIO else {
                "inputs": [], "outputs": [], "voices": [], "local": None,
            })
        elif path == "/api/audio/status":
            self.send_json(LOCAL_AUDIO.status() if LOCAL_AUDIO else {})
        elif path == "/api/camera/devices":
            self.send_json({
                "cameras": LOCAL_CAMERA.devices() if LOCAL_CAMERA else [],
                "status": LOCAL_CAMERA.status() if LOCAL_CAMERA else None,
            })
        elif path == "/api/camera/snapshot":
            self.send_image(LOCAL_CAMERA.capture() if LOCAL_CAMERA else None)
        elif path == "/api/alexa":
            self.send_json(alexa_devices_preview(CONTROLLER))
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

        if path == "/alexa":
            token = (CONFIG.get("alexa") or {}).get("token")
            if token:
                auth = self.headers.get("Authorization", "")
                if auth not in ("Bearer " + token, token):
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
        if path == "/api/gemini/chat":
            result = _gemini_call(api_key, data.get("prompt", ""), provider=provider, model=model, ollama_url=ollama_url)
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
            result = _gemini_call(
                api_key, "", audio, mime, local=use_local_mic,
                provider=provider, model=model, ollama_url=ollama_url,
            )
        self.send_json(result)


def _gemini_call(api_key: str, prompt: str = "", audio: bytes | None = None,
                 mime_type: str = "audio/webm", local: bool = False,
                 speak_local: bool = True,
                 image_bytes: bytes | None = None,
                 image_mime: str = "image/jpeg",
                 provider: str = "google",
                 model: str = "",
                 ollama_url: str = "") -> dict[str, Any]:
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
    text = str(result.get("text") or "").strip()
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
        voice = assistant.get("server_voice") or "us"
        data, audio_mime = LOCAL_AUDIO.synthesize(text, voice)
        if data:
            result["audio_b64"] = base64.b64encode(data).decode("ascii")
            result["audio_mime"] = audio_mime
            if speak_local:
                LOCAL_AUDIO.play(data, audio_mime, text)
    return result


def _local_audio_request(audio: bytes, mime_type: str) -> dict[str, Any] | None:
    api_key = _gemini_key({})
    if not api_key:
        return None
    image = None
    camera_cfg = (CONFIG.get("camera") or {}).get("local") or {}
    if LOCAL_CAMERA and camera_cfg.get("vision_on_voice", True):
        image = LOCAL_CAMERA.capture()
    return _gemini_call(
        api_key, "", audio, mime_type, local=True,
        image_bytes=image, image_mime="image/jpeg",
        provider=_ai_provider({}),
    )


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
    LOCAL_AUDIO.start()
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
        if LOCAL_AUDIO:
            LOCAL_AUDIO.stop()
        httpd.server_close()


if __name__ == "__main__":
    main()
