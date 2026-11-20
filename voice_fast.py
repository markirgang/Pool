#!/usr/bin/env python3
"""Fast voice pipeline helpers.

Instead of one large multimodal call (audio + camera image + tools) that
took 4-5 s, voice requests are handled in steps:

1. transcribe() sends only the audio to a fast "lite" model (~0.7 s);
2. the server checks the wake word on that text, so background speech is
   dropped after the cheap call;
3. match_command() handles common commands (light colors, party mode,
   lights, pool/spa mode, heater, jets, fountains, blower, temperature and
   salt) instantly without an AI call;
4. anything else goes to the chat model as text, with the camera image only
   when the user asks Iggy to look (wants_vision()).
"""

from __future__ import annotations

import logging
import re
from typing import Any

LOG = logging.getLogger("pool.voice")

DEFAULT_STT_MODEL = "gemini-4-argon"
DEFAULT_REPLY_MODEL = "glm-5.3-flash"  # ~1.6 s with reliable tool calls (Nov 2026 tests)

# Don't mention the assistant's name here: the model then "hears" Iggy in
# background noise and Iggy answers when nobody spoke to him.
_TRANSCRIBE_PROMPT = (
    "Transcribe the human speech in this recording exactly as spoken, in English. "
    "Reply with only the words, no quotes or labels. If there is no clear human "
    "speech (silence, noise, music, clicks), reply with exactly: NONE"
)


def transcribe(api_key: str, audio: bytes, mime_type: str, model: str = "",
               provider: str = "") -> str:
    """Speech to text with a fast model. Raises on API failure."""
    import ai_engine
    from google.genai import types

    contents = [types.Part.from_bytes(data=audio, mime_type=mime_type or "audio/wav"),
                _TRANSCRIBE_PROMPT]
    config = types.GenerateContentConfig(temperature=0, max_output_tokens=160)
    result = ai_engine.call_ai(api_key=api_key, contents=contents, config=config,
                               provider=provider, model=model or DEFAULT_STT_MODEL)
    text = str(result.get("text") or "").strip().strip('"').strip()
    # call_ai reports failures as text, and an empty answer as "Done."
    if re.search(r"API error:|out of credits|library is not installed|provide an API key", text):
        raise RuntimeError(text[:200])
    if text == "Done." or result.get("action"):
        return ""
    # Non-speech markers, e.g. "NONE", "[keyboard clicking]", "<noise>".
    if re.fullmatch(r"(?i)none\.?|[\[(<].*[\])>]\.?", text):
        return ""
    return text


def is_only_wake_word(text: str) -> bool:
    """True for "Iggy", "Hey Iggy!", "Iggy Iggy Iggy": a name with no request."""
    rest = re.sub(r"(?i)\b(hey|hi|ok|okay|yo|oh|um|uh|iggy|iggie|iggi|iggey|igy|ziggy)\b", "", text or "")
    return not re.sub(r"[\s,.!?'-]", "", rest)


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z']+", (text or "").lower()))


def is_echo(text: str, last_reply: str) -> bool:
    """True when the mic most likely heard Iggy's own reply from the speaker."""
    heard, said = _words(text) - {"iggy"}, _words(last_reply) - {"iggy"}
    return len(heard) >= 3 and len(heard & said) / len(heard) >= 0.6


_VISION = re.compile(
    r"\b(look|looking|see|seeing|camera|showing|holding|what is this|what's this|"
    r"what do you see|can you see)\b", re.I)


def wants_vision(text: str) -> bool:
    return bool(_VISION.search(text or ""))


# ----------------------------------------------------------------------
# Instant commands (no AI call)
# ----------------------------------------------------------------------
_COLORS = [
    ("PARTY", r"party"), ("ROYAL", r"royal(?: blue)?"), ("CARIB", r"caribbean"),
    ("AMERCA", r"american|red,? white and blue"), ("SSET", r"sunset|orange"),
    ("ROMAN", r"romance|romantic"), ("MAGNTAR", r"magenta|pink|purple"),
    ("BLUER", r"blue"), ("GREENR", r"green"), ("REDR", r"red"), ("WHITER", r"white"),
]
_COLOR_SPOKEN = {"PARTY": "party mode", "ROYAL": "royal blue", "CARIB": "caribbean blue",
                 "AMERCA": "red, white and blue", "SSET": "sunset", "ROMAN": "romance",
                 "MAGNTAR": "magenta", "BLUER": "blue", "GREENR": "green", "REDR": "red",
                 "WHITER": "white"}
_JETS = {"ne": r"north ?east|n\.?e\.?", "nw": r"north ?west|n\.?w\.?",
         "se": r"south ?east|s\.?e\.?", "sw": r"south ?west|s\.?w\.?"}
_WAKE = re.compile(r"^\s*(?:(?:hey|ok|okay|hi|yo)\s+)?(?:iggy|iggie|iggi|iggey|igy|ziggy|eggy|eggie|yagi)\b[\s,.!?-]*", re.I)


def _clean(text: str) -> str:
    text = _WAKE.sub("", text or "")
    text = re.sub(r"[,.!?]+\s*(iggy|iggie|eggy)\s*[.!?]*$", "", text, flags=re.I)
    return re.sub(r"\s+", " ", text.lower()).strip(" ,.!?")


def _password(text: str) -> str | None:
    """Burner password spoken as "..., password <word>"."""
    found = re.search(r"\b(?:password|pass ?code|code)(?: is)?,? (\S+)", text)
    return found.group(1).strip(",.!?") if found else None


def _on_off(text: str) -> bool | None:
    off = re.search(r"\b(off|stop|shut|kill|disable)\b", text)
    on = re.search(r"\b(on|start|enable|activate|run)\b", text)
    if off and not on:
        return False
    if on and not off:
        return True
    return None


def _temp(state: dict[str, Any], body: str) -> Any:
    return ((state.get("bodies") or {}).get(body) or {}).get("temp")


def common_replies() -> list[str]:
    """Fixed replies of the instant commands, for pre-generating their speech."""
    replies = ["Party mode is on."]
    for spoken in _COLOR_SPOKEN.values():
        replies += ["All the lights are now %s." % spoken, "The pool light is now %s." % spoken,
                    "The spa light is now %s." % spoken]
    for state in ("on", "off"):
        replies += ["The lights are %s." % state, "The spa light is %s." % state,
                    "The heater is %s." % state, "The spa blower is %s." % state,
                    "The floor jets are %s." % state, "The firepit fountains are %s." % state,
                    "All the water features are %s." % state]
        replies += ["The %s floor jet is %s." % (jet.upper(), state) for jet in _JETS]
    return replies + ["Switching to spa mode.", "Switching to pool mode."]


def match_command(transcript: str, state: dict[str, Any]) -> tuple[str | None, dict, str] | None:
    """Return (action, payload, spoken reply) for a simple command, else None.

    Anything ambiguous returns None so the AI handles it.
    """
    text = _clean(transcript)
    if not text or len(text.split()) > 14 or re.search(r"\b(don't|do not|why|if|when|after|before|schedule|minutes?|hours?)\b", text):
        return None
    # Questions ("which lights are on?") never run commands; only the
    # temperature/salt answers below may handle them.
    question = bool(re.match(r"(what|which|is|are|how|does|do|did|why|where|who|whose|tell me|can you tell)\b", text))
    # Two requests in one sentence ("the spa and the heater") go to the AI.
    if re.search(r"\b(and|then|also|but)\b", re.sub(r"red,? white and blue", "", text)):
        return None

    if question:
        return _answer(text, state)

    # Light colors and party mode
    if re.search(r"\bparty\b", text) and not re.search(r"\boff\b", text):
        return ("set_all_lights", {"on": True, "effect": "PARTY"}, "Party mode is on.")
    for effect, pattern in _COLORS:
        if re.search(r"\b(%s)\b" % pattern, text) and re.search(
                r"\b(turn|make|set|change|switch|go|put|lights?|pool|spa|all)\b", text):
            if re.search(r"\bspa\b", text) and not re.search(r"\b(pool|all|both|everything)\b", text):
                return ("set_light", {"body": "spa", "on": True, "effect": effect},
                        "The spa light is now %s." % _COLOR_SPOKEN[effect])
            if re.search(r"\bpool\b", text) and not re.search(r"\b(spa|all|both|everything)\b", text):
                return ("set_light", {"body": "pool", "on": True, "effect": effect},
                        "The pool light is now %s." % _COLOR_SPOKEN[effect])
            return ("set_all_lights", {"on": True, "effect": effect},
                    "All the lights are now %s." % _COLOR_SPOKEN[effect])

    on = _on_off(text)

    if on is not None and (
            re.search(r"\b(burner|fire ?pit|fire ?basket|fire)s? (led )?(lights?|leds?|strips?)\b", text)
            or re.search(r"\b(lights?|leds?|strips?) under (the )?(burners?|fire ?pits?|fire ?baskets?)\b", text)):
        return ("set_firebasket", {"id": "east", "burner_light": on},
                "The burner lights are %s." % ("on" if on else "off"))

    if re.search(r"\blights?\b", text) and on is not None:
        if re.search(r"\bspa\b", text) and not re.search(r"\bpool\b", text):
            return ("set_light", {"body": "spa", "on": on}, "The spa light is %s." % ("on" if on else "off"))
        return ("set_all_lights", {"on": on}, "The lights are %s." % ("on" if on else "off"))

    if re.search(r"\bheat(er|ing)?\b", text) and on is not None:
        return ("set_heater", {"on": on}, "The heater is %s." % ("on" if on else "off"))

    if re.search(r"\b(blower|bubbles|bubblers?|air jets?)\b", text) and on is not None:
        return ("set_blower", {"on": on}, "The spa blower is %s." % ("on" if on else "off"))

    if re.search(r"\bjets?\b", text) and on is not None:
        named = [jet for jet, pattern in _JETS.items() if re.search(r"\b(%s)\b" % pattern, text)]
        if len(named) == 1:
            jet = named[0]
            return ("set_deck_jet", {"id": jet, "on": on},
                    "The %s floor jet is %s." % (jet.upper(), "on" if on else "off"))
        if not named and re.search(r"\b(all|the|floor|deck)\b", text):
            return ("set_all_jets", {"on": on}, "The floor jets are %s." % ("on" if on else "off"))

    burner_on = on
    if burner_on is None and re.search(r"^(please )?(light|ignite) (up )?(the )?(burners?|fires?|fire ?pits?|fire ?baskets?)\b", text):
        burner_on = True
    if re.search(r"\b(burners?|flames?|fires?)\b", text) and burner_on is not None \
            and not re.search(r"\b(fountains?|spillways?)\b", text):
        on = burner_on
        payload = {"id": "east", "on": on}
        if _password(text):
            payload["password"] = _password(text)
        return ("set_firebasket", payload,
                "The burners are %s." % ("on" if on else "off"))
    if re.search(r"\b(fountains?|fire ?pits?|fire ?baskets?|spillways?)\b", text) \
            and on is not None and not re.search(r"\b(east|west|pool|spa)\b", text):
        return ("set_all_firebaskets", {"on": on}, "The firepit fountains are %s." % ("on" if on else "off"))
    if re.search(r"\b(all (the )?)?(water )?features\b", text) and on is not None:
        payload = {"on": on}
        if _password(text):
            payload["password"] = _password(text)
        return ("set_all_features", payload,
                "All the water features are %s." % ("on" if on else "off"))

    if re.search(r"\b(spa|hot tub|jacuzzi) mode\b|\bswitch to (the )?(spa|hot tub)\b|^turn on the (spa|hot tub)$", text):
        return ("set_mode", {"mode": "spa"}, "Switching to spa mode.")
    if re.search(r"\bpool mode\b|\bswitch to (the )?pool\b", text):
        return ("set_mode", {"mode": "pool"}, "Switching to pool mode.")

    return _answer(text, state)


def _answer(text: str, state: dict[str, Any]) -> tuple[str | None, dict, str] | None:
    """Instant answers to temperature and salt questions; anything else -> AI."""
    if re.search(r"\b(temperature|temp|how (warm|hot|cold))\b", text) and not re.search(r"\b(set|change|raise|lower)\b", text):
        parts = []
        for body in ("pool", "spa"):
            value = _temp(state, body)
            if value is not None and (body in text or not re.search(r"\b(pool|spa)\b", text)):
                parts.append("the %s is %d degrees" % (body, round(value)))
        if parts:
            reply = " and ".join(parts)
            return (None, {}, reply[0].upper() + reply[1:] + ".")
        return None

    if re.search(r"\bsalt\b", text):
        salt = (state.get("chemistry") or {}).get("salt")
        if salt is not None:
            return (None, {}, "The salt level is %s parts per million." % salt)

    return None
