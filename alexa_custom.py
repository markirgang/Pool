#!/usr/bin/env python3
"""Alexa Custom Skill ("Alexa, ask Lighthouse Pool to ...") for the pool app.

A Custom Skill can call an HTTPS endpoint directly, so Alexa reaches
https://pool.shobots.party/alexa through the Cloudflare tunnel with no AWS
Lambda in between. Amazon requires such endpoints to verify that every
request is signed by Alexa; verify_request() implements that check, and
the configured Skill ID ensures only *your* skill can control the pool.

interaction_model() returns the JSON to paste into the Alexa developer
console (Build > Interaction Model > JSON Editor).
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import posixpath
import threading
import urllib.parse
import urllib.request
import warnings
from typing import Any, Callable

LOG = logging.getLogger("pool.alexa")

# Light effects understood by the Pentair IntelliBrite light.
COLORS = {
    "BLUER": ("blue", ["light blue", "dark blue", "ocean blue"]),
    "GREENR": ("green", []),
    "REDR": ("red", []),
    "WHITER": ("white", []),
    "MAGNTAR": ("magenta", ["pink", "purple"]),
    "PARTY": ("party", ["party mode", "party colors", "disco"]),
    "CARIB": ("caribbean", ["caribbean blue"]),
    "SSET": ("sunset", ["orange"]),
    "ROMAN": ("romance", ["romantic"]),
    "AMERCA": ("american", ["red white and blue", "america"]),
    "ROYAL": ("royal", ["royal blue"]),
}
TARGETS = {
    "POOL": ("pool", ["pool light", "pool lights"]),
    "SPA": ("spa", ["spa light", "spa lights", "hot tub"]),
    "ALL": ("all", ["all lights", "all the lights", "the lights", "everything", "both"]),
}
MODES = {
    "POOL": ("pool", []),
    "SPA": ("spa", ["hot tub", "jacuzzi"]),
}

_TIMESTAMP_TOLERANCE = 150  # seconds, per Amazon's requirements
_cert_cache: dict[str, Any] = {}
_cert_lock = threading.Lock()


# ----------------------------------------------------------------------
# Request verification
# ----------------------------------------------------------------------
def _valid_cert_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    path = posixpath.normpath(parsed.path)
    return (
        parsed.scheme.lower() == "https"
        and (parsed.hostname or "").lower() == "s3.amazonaws.com"
        and parsed.port in (None, 443)
        and path.startswith("/echo.api/")
    )


def _signing_cert(url: str):
    from cryptography import x509
    from cryptography.x509 import DNSName
    from cryptography.x509.verification import PolicyBuilder, Store
    import certifi

    with _cert_lock:
        cached = _cert_cache.get(url)
    now = dt.datetime.now(dt.timezone.utc)
    if cached and cached.not_valid_after_utc > now:
        return cached
    with urllib.request.urlopen(url, timeout=5) as resp:
        chain = x509.load_pem_x509_certificates(resp.read())
    with open(certifi.where(), "rb") as fh, warnings.catch_warnings():
        # A few bundled roots have non-RFC serial numbers; harmless here.
        warnings.simplefilter("ignore")
        roots = x509.load_pem_x509_certificates(fh.read())
    verifier = (PolicyBuilder().store(Store(roots)).time(now)
                .build_server_verifier(DNSName("echo-api.amazon.com")))
    verifier.verify(chain[0], chain[1:])  # chain, validity dates and SAN
    with _cert_lock:
        _cert_cache[url] = chain[0]
    return chain[0]


def verify_request(raw_body: bytes, headers: Any, body: dict[str, Any],
                   skill_id: str) -> tuple[bool, str]:
    """Check Amazon's signature, the timestamp and the Skill ID."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    cert_url = headers.get("SignatureCertChainUrl", "")
    signature = headers.get("Signature-256", "")
    if not cert_url or not signature:
        return False, "missing Alexa signature headers"
    if not _valid_cert_url(cert_url):
        return False, "untrusted signature certificate URL"
    try:
        cert = _signing_cert(cert_url)
        cert.public_key().verify(base64.b64decode(signature), raw_body,
                                 padding.PKCS1v15(), hashes.SHA256())
    except Exception as exc:  # any failure means the request is not genuine
        return False, "bad Alexa signature (%s)" % exc.__class__.__name__

    stamp = str((body.get("request") or {}).get("timestamp", ""))
    try:
        sent = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return False, "missing request timestamp"
    if abs((dt.datetime.now(dt.timezone.utc) - sent).total_seconds()) > _TIMESTAMP_TOLERANCE:
        return False, "stale request timestamp"

    app_id = application_id(body)
    if not skill_id:
        return False, ("no Skill ID configured; set alexa.skill_id to %s in the "
                       "Alexa tab if that is your skill" % app_id)
    if app_id != skill_id:
        return False, "request is for a different skill (%s)" % app_id
    return True, "ok"


def application_id(body: dict[str, Any]) -> str:
    system = (body.get("context") or {}).get("System") or {}
    app = system.get("application") or (body.get("session") or {}).get("application") or {}
    return str(app.get("applicationId", ""))


def is_custom_skill_request(body: dict[str, Any]) -> bool:
    return isinstance(body.get("request"), dict) and "version" in body


# ----------------------------------------------------------------------
# Request handling
# ----------------------------------------------------------------------
def _speak(text: str, end: bool = True, reprompt: str | None = None) -> dict[str, Any]:
    response: dict[str, Any] = {
        "outputSpeech": {"type": "PlainText", "text": text},
        "shouldEndSession": end,
    }
    if reprompt:
        response["reprompt"] = {"outputSpeech": {"type": "PlainText", "text": reprompt}}
    return {"version": "1.0", "response": response}


def _slot(intent: dict[str, Any], name: str, table: dict[str, tuple[str, list[str]]]) -> str | None:
    """Return the canonical id for a slot, using Alexa's entity resolution."""
    slot = (intent.get("slots") or {}).get(name) or {}
    for authority in ((slot.get("resolutions") or {}).get("resolutionsPerAuthority") or []):
        if (authority.get("status") or {}).get("code") == "ER_SUCCESS_MATCH":
            for value in authority.get("values") or []:
                ident = ((value.get("value") or {}).get("id") or "").upper()
                if ident in table:
                    return ident
    spoken = str(slot.get("value") or "").strip().lower()
    for ident, (value, synonyms) in table.items():
        if spoken == value or spoken in synonyms:
            return ident
    return None


_SPOKEN = {"PARTY": "party mode", "ROYAL": "royal blue", "AMERCA": "red, white and blue",
           "CARIB": "caribbean blue"}


def _color_name(effect: str) -> str:
    return _SPOKEN.get(effect) or COLORS[effect][0]


def _temps(state: dict[str, Any]) -> str:
    bodies = state.get("bodies") or {}
    parts = []
    for body in ("pool", "spa"):
        temp = (bodies.get(body) or {}).get("temp")
        if temp is not None:
            parts.append("the %s is %d degrees" % (body, round(temp)))
    return " and ".join(parts) if parts else "the panel isn't reporting water temperatures right now"


HELP = ("You can say: turn the pool blue, start party mode, turn all the lights back "
        "to blue, switch to spa mode, or what's the water temperature.")


def handle(body: dict[str, Any], controller: Any,
           ask_iggy: Callable[[str], str] | None = None,
           skill_name: str = "Lighthouse Pool") -> dict[str, Any]:
    request = body.get("request") or {}
    kind = request.get("type")
    if kind == "LaunchRequest":
        return _speak("Welcome to %s. %s" % (skill_name, HELP), end=False,
                      reprompt="What would you like the pool to do?")
    if kind == "SessionEndedRequest":
        return {"version": "1.0", "response": {}}
    if kind != "IntentRequest":
        return _speak("Sorry, I didn't understand that.")

    intent = request.get("intent") or {}
    name = intent.get("name", "")
    if name in ("AMAZON.HelpIntent", "AMAZON.FallbackIntent"):
        return _speak(HELP, end=False, reprompt="What would you like the pool to do?")
    if name in ("AMAZON.StopIntent", "AMAZON.CancelIntent", "AMAZON.NavigateHomeIntent"):
        return _speak("Okay.")

    if name == "PartyModeIntent":
        result = controller.command("set_all_lights", {"on": True, "effect": "PARTY"})
        return _speak("Party mode is on." if result.get("ok")
                      else "I couldn't start party mode: %s" % result.get("message"))

    if name == "LightColorIntent":
        effect = _slot(intent, "color", COLORS)
        target = _slot(intent, "light", TARGETS) or "ALL"
        if not effect:
            return _speak("Which color? For example blue, green, red, white, or party mode.",
                          end=False, reprompt="Which color would you like?")
        if target == "ALL":
            result = controller.command("set_all_lights", {"on": True, "effect": effect})
            done = "All the lights are now %s." % _color_name(effect)
        else:
            body_name = target.lower()
            result = controller.command("set_light", {"body": body_name, "on": True,
                                                      "effect": effect})
            done = "The %s light is now %s." % (body_name, _color_name(effect))
        return _speak(done if result.get("ok")
                      else "I couldn't change the lights: %s" % result.get("message"))

    if name in ("LightsOnIntent", "LightsOffIntent"):
        on = name == "LightsOnIntent"
        target = _slot(intent, "light", TARGETS) or "ALL"
        if target == "ALL":
            result = controller.command("set_all_lights", {"on": on})
            done = "All the lights are %s." % ("on" if on else "off")
        else:
            result = controller.command("set_light", {"body": target.lower(), "on": on})
            done = "The %s light is %s." % (target.lower(), "on" if on else "off")
        return _speak(done if result.get("ok")
                      else "I couldn't change the lights: %s" % result.get("message"))

    if name == "SetModeIntent":
        mode = _slot(intent, "mode", MODES)
        if not mode:
            return _speak("Pool mode or spa mode?", end=False, reprompt="Pool or spa?")
        result = controller.command("set_mode", {"mode": mode.lower()})
        return _speak("Switched to %s mode." % mode.lower() if result.get("ok")
                      else "I couldn't switch modes: %s" % result.get("message"))

    if name == "TemperatureIntent":
        text = _temps(controller.state())
        return _speak(text[0].upper() + text[1:] + ".")

    if name == "AskIggyIntent":
        query = str(((intent.get("slots") or {}).get("query") or {}).get("value") or "").strip()
        if not query:
            return _speak("What should I tell Iggy?", end=False, reprompt="What should I tell Iggy?")
        if not ask_iggy:
            return _speak("Iggy isn't available right now.")
        return _speak(ask_iggy(query) or "Iggy didn't have an answer.")

    return _speak("Sorry, %s can't do that yet. %s" % (skill_name, HELP))


# ----------------------------------------------------------------------
# Interaction model for the Alexa developer console
# ----------------------------------------------------------------------
def _slot_type(name: str, table: dict[str, tuple[str, list[str]]]) -> dict[str, Any]:
    return {
        "name": name,
        "values": [
            {"id": ident, "name": {"value": value, "synonyms": synonyms}}
            for ident, (value, synonyms) in table.items()
        ],
    }


def interaction_model(invocation_name: str = "lighthouse pool") -> dict[str, Any]:
    light, color, mode = "{light}", "{color}", "{mode}"
    return {
        "interactionModel": {
            "languageModel": {
                "invocationName": invocation_name.lower(),
                "intents": [
                    {"name": "AMAZON.CancelIntent", "samples": []},
                    {"name": "AMAZON.HelpIntent", "samples": []},
                    {"name": "AMAZON.StopIntent", "samples": []},
                    {"name": "AMAZON.NavigateHomeIntent", "samples": []},
                    {"name": "AMAZON.FallbackIntent", "samples": []},
                    {
                        "name": "LightColorIntent",
                        "slots": [
                            {"name": "light", "type": "LIGHT_TARGET"},
                            {"name": "color", "type": "LIGHT_COLOR"},
                        ],
                        "samples": [
                            "turn the %s %s" % (light, color),
                            "turn %s %s" % (light, color),
                            "make the %s %s" % (light, color),
                            "set the %s to %s" % (light, color),
                            "change the %s to %s" % (light, color),
                            "turn the %s back to %s" % (light, color),
                            "turn %s back to %s" % (light, color),
                            "set %s to %s" % (light, color),
                            "go %s" % color,
                            "turn it %s" % color,
                        ],
                    },
                    {
                        "name": "PartyModeIntent",
                        "samples": [
                            "turn on party mode", "start party mode", "party mode",
                            "start the party", "party time", "put the lights in party mode",
                        ],
                    },
                    {
                        "name": "LightsOnIntent",
                        "slots": [{"name": "light", "type": "LIGHT_TARGET"}],
                        "samples": ["turn on the %s light" % light, "turn on the %s lights" % light,
                                    "turn the %s light on" % light, "turn the %s lights on" % light,
                                    "switch on the %s lights" % light, "lights on",
                                    "turn on the lights"],
                    },
                    {
                        "name": "LightsOffIntent",
                        "slots": [{"name": "light", "type": "LIGHT_TARGET"}],
                        "samples": ["turn off the %s light" % light, "turn off the %s lights" % light,
                                    "turn the %s light off" % light, "turn the %s lights off" % light,
                                    "switch off the %s lights" % light, "lights off",
                                    "turn off the lights"],
                    },
                    {
                        "name": "SetModeIntent",
                        "slots": [{"name": "mode", "type": "BODY_MODE"}],
                        "samples": ["switch to %s mode" % mode, "switch to the %s" % mode,
                                    "turn on the %s" % mode,
                                    "%s mode" % mode, "change to %s mode" % mode,
                                    "set it to %s mode" % mode],
                    },
                    {
                        "name": "TemperatureIntent",
                        "samples": ["what is the temperature", "what's the water temperature",
                                    "how warm is the water", "how hot is the spa",
                                    "how warm is the pool", "what's the pool temperature",
                                    "what's the spa temperature"],
                    },
                    {
                        "name": "AskIggyIntent",
                        "slots": [{"name": "query", "type": "AMAZON.SearchQuery"}],
                        "samples": ["tell iggy {query}", "ask iggy {query}"],
                    },
                ],
                "types": [
                    _slot_type("LIGHT_TARGET", TARGETS),
                    _slot_type("LIGHT_COLOR", COLORS),
                    _slot_type("BODY_MODE", MODES),
                ],
            }
        }
    }


if __name__ == "__main__":
    print(json.dumps(interaction_model(), indent=2))
