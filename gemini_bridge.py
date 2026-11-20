#!/usr/bin/env python3
"""Gemini multimodal assistant for conversational pool control.

The assistant can answer questions about the pool, explain what is running,
and call tools that map onto PoolController commands.
"""

from __future__ import annotations

import json
from typing import Any
from ai_engine import call_ai

try:
    from google import genai
    from google.genai import types
    GENAI_AVAILABLE = True
except Exception:  # pragma: no cover - optional dependency
    genai = None
    types = None
    GENAI_AVAILABLE = False

from pool_controller import LIGHT_EFFECTS

MODEL = "gemini-3.5-flash-lite"
OPENCODE_MODELS = {
    "opencode-go": "gemini-4-argon",
    "opencode": "gemini-3.8-flash",
}
OPENCODE_BASE_URLS = {
    "opencode-go": "https://opencode.ai/inference/go/google/",
    "opencode": "https://opencode.ai/inference/google/",
}

_TOOL_ACTIONS = {
    "pool_set_mode": "set_mode",
    "pool_set_deck_jet": "set_deck_jet",
    "pool_set_firebasket": "set_firebasket",
    "pool_set_all_features": "set_all_features",
    "pool_set_blower": "set_blower",
    "pool_set_light": "set_light",
    "pool_set_all_lights": "set_all_lights",
    "pool_set_spillway_color": "set_spillway_color",
    "pool_set_heater": "set_heater",
    "pool_set_pump": "set_pump",
    "pool_get_status": "status",
    "pool_system_off": "system_off",
    "pool_open_host_page": "open_host_page",
}

_EFFECTS = sorted(LIGHT_EFFECTS.keys())


# Wake word / trigger name context: pool
PERSONALITIES = {
    "classic": (
        "You are Iggy, a funny, friendly talking iguana who lives on the deck and "
        "runs the Lighthouse Point Pool through its Pentair IntelliCenter. Speak in "
        "first person as the iguana: you lounge by the water, keep an eye on the "
        "firebaskets, and enjoy a warm spa."
    ),
    "surfer": (
        "You are Iggy, a laid-back surfer iguana who lives on the deck at Lighthouse "
        "Point Pool. You speak with a relaxed beach attitude, call people 'dude' "
        "occasionally, and treat every pool command like the start of a good session."
    ),
    "butler": (
        "You are Iggy, an impeccably polite British pool butler iguana at Lighthouse "
        "Point Pool. You are composed, dryly witty, and address the owner with "
        "courteous formality while still being warm and helpful."
    ),
    "pirate": (
        "You are Iggy, a cheerful pirate iguana who guards Lighthouse Point Pool. "
        "You use light nautical and pirate flavor ('ahoy', 'matey', 'smooth sailing') "
        "without being hard to understand, and you take pool chores seriously."
    ),
    "deadpan": (
        "You are Iggy, a deadpan iguana pool operator at Lighthouse Point Pool. You "
        "deliver short, dry, understated jokes with a completely straight face, then "
        "give the useful answer."
    ),
    "custom": "",
}

_BASE_FACTS = (
    "Your project name is 'pool'. You respond whenever the user mentions your name ('pool') anywhere in the continuous sentence (e.g. 'Hey pool, ...' or 'Can you move for me pool?'). Keep responses concise, helpful, and under 25 words for fast speech output. "
   
    "You control two bodies of water: the pool and the spa. The pool is the default "
    "mode. The main variable-speed pump circulates the pool/spa. A secondary "
    "variable-speed pump runs whenever any water feature is on. Water features are "
    "four deck laminar jets (NE, NW, SE, SW), which the Pentair panel calls NE, NW, "
    "SE and SW Floor Jets, and two firebaskets (east and west). Each firebasket has a "
    "pool fountain and a spa fountain; the panel calls them Pool Fountain E/W and "
    "Spa Fountain E/W. There is also a spa air blower on the Blower circuit. The "
    "default color for the pool lights is steady blue. Firebasket ignition and "
    "propane are automatic when the IntelliCenter supplies 12 VAC to the burner. "
    "Relay AUX 5 (Burners) runs both firebasket burners together; the burners are a "
    "separate feature and only light when asked for (spillway 'flame') or when all "
    "water features are turned on. AUX 6 (Spa Spillway) runs both spa spillway "
    "lights and AUX 7 (Pool Spillway) runs both pool spillway lights; those lights "
    "follow the spillways automatically. Relay AUX 1 (Burner Lights) runs the LED "
    "strips under both firebasket burners together; they are a separate feature "
    "(spillway 'lights') and also switch with all water features. Lighting the "
    "burners needs the burner password: pass the password the user says; if they "
    "did not give one, ask them for it. You do not know the password, never guess "
    "it, and never repeat it back. Turning burners off needs no password. "
    "There are color LED pool and spa lights, and a heater. IntelliCenter automatically "
    "moves the 3-way drain and return valves in pool/spa mode."
)

_RULES = (
    "Answer in a relaxed, conversational way: relatively short, but not so short "
    "that it feels clipped, and add a little iguana humor when it fits. When asked "
    "about the pool temperature, always report BOTH the spa and the pool "
    "temperatures. When asked for the pool status, the spa status, or how everything "
    "is doing, say out loud the pool temperature, spa temperature, salt/chemistry "
    "level, pumps, heater, deck/floor jets, firebasket fountains, spa blower and "
    "lights. When asked about pool chemistry or water quality, report the salt level "
    "in ppm and the salt source (and say plainly if no other chemistry readings are "
    "available). Use the tools to make changes. If the user asks for several things, call one "
    "tool at a time. Never invent equipment that is not available. If a command "
    "cannot be applied because the panel is offline, say it was applied in "
    "simulation mode. When asked to open the IntelliCenter host page or web panel, "
    "call the pool_open_host_page tool."
)


class GeminiPoolBridge:
    def __init__(self) -> None:
        self.system_instruction = self.system_prompt(None)

    @staticmethod
    def model_for(provider: str) -> str:
        return OPENCODE_MODELS.get(provider, MODEL)

    def system_prompt(self, assistant: dict[str, Any] | None = None) -> str:
        assistant = assistant or {}
        preset = str(assistant.get("personality") or "classic").lower()
        persona = PERSONALITIES.get(preset, PERSONALITIES["classic"])
        if preset == "custom":
            persona = str(assistant.get("personality_custom") or "").strip()
            if not persona:
                persona = PERSONALITIES["classic"]
            persona = "You are Iggy, the Lighthouse Point Pool iguana. " + persona
        return persona + "\n" + _BASE_FACTS + "\n" + _RULES

    def _tools(self):
        if not GENAI_AVAILABLE:
            return []
        return [
            types.Tool(function_declarations=[
                types.FunctionDeclaration(
                    name="pool_set_mode",
                    description="Switch the pool between pool mode and spa mode.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "mode": types.Schema(
                                type=types.Type.STRING,
                                enum=["pool", "spa"],
                            )
                        },
                        required=["mode"],
                    ),
                ),
                types.FunctionDeclaration(
                    name="pool_set_deck_jet",
                    description="Turn one deck/floor laminar jet on or off.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "jet": types.Schema(
                                type=types.Type.STRING,
                                enum=["ne", "nw", "se", "sw"],
                            ),
                            "on": types.Schema(type=types.Type.BOOLEAN),
                            "light": types.Schema(type=types.Type.BOOLEAN),
                            "thumper": types.Schema(type=types.Type.BOOLEAN),
                        },
                        required=["jet", "on"],
                    ),
                ),
                types.FunctionDeclaration(
                    name="pool_set_firebasket",
                    description="Control one firepit (east or west): its pool spillway, spa spillway, both spillways, 'flame' for the burners, or 'lights' for the LED burner lights under the burners. Burners and burner lights are each shared by both firepits and only change when 'flame' or 'lights' is chosen.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "basket": types.Schema(
                                type=types.Type.STRING, enum=["east", "west"]
                            ),
                            "on": types.Schema(type=types.Type.BOOLEAN),
                            "spillway": types.Schema(
                                type=types.Type.STRING, enum=["pool", "spa", "both", "flame", "lights"]
                            ),
                            "password": types.Schema(
                                type=types.Type.STRING,
                                description="Burner password exactly as the user said it; required to light the burners ('flame' on).",
                            ),
                        },
                        required=["basket", "on"],
                    ),
                ),
                types.FunctionDeclaration(
                    name="pool_set_all_features",
                    description="Turn all deck jets and firebaskets on or off together. Without the burner password, 'on' lights everything except the burners.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "on": types.Schema(type=types.Type.BOOLEAN),
                            "password": types.Schema(
                                type=types.Type.STRING,
                                description="Burner password if the user gave one.",
                            ),
                        },
                        required=["on"],
                    ),
                ),
                types.FunctionDeclaration(
                    name="pool_set_blower",
                    description="Turn the spa air blower on or off.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={"on": types.Schema(type=types.Type.BOOLEAN)},
                        required=["on"],
                    ),
                ),
                types.FunctionDeclaration(
                    name="pool_set_light",
                    description="Turn the pool or spa color LED on/off and optionally choose a color effect.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "body": types.Schema(
                                type=types.Type.STRING, enum=["pool", "spa"]
                            ),
                            "on": types.Schema(type=types.Type.BOOLEAN),
                            "effect": types.Schema(
                                type=types.Type.STRING, enum=_EFFECTS
                            ),
                        },
                        required=["body"],
                    ),
                ),
                types.FunctionDeclaration(
                    name="pool_set_all_lights",
                    description=("Set every color light (pool and spa) at once. Use for "
                                 "'party mode' (effect PARTY) or 'turn all the lights back "
                                 "to blue' (effect BLUER)."),
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "on": types.Schema(type=types.Type.BOOLEAN),
                            "effect": types.Schema(
                                type=types.Type.STRING, enum=_EFFECTS
                            ),
                        },
                    ),
                ),
                types.FunctionDeclaration(
                    name="pool_set_spillway_color",
                    description="Set the firebasket spillway LED color effect (default is steady blue).",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "effect": types.Schema(
                                type=types.Type.STRING, enum=_EFFECTS
                            )
                        },
                        required=["effect"],
                    ),
                ),
                types.FunctionDeclaration(
                    name="pool_set_heater",
                    description="Turn the pool heater on or off.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "on": types.Schema(type=types.Type.BOOLEAN),
                        },
                        required=["on"],
                    ),
                ),
                types.FunctionDeclaration(
                    name="pool_set_pump",
                    description="Turn the main or features variable-speed pump on/off and optionally set RPM.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "pump": types.Schema(
                                type=types.Type.STRING,
                                enum=["main", "features"],
                            ),
                            "on": types.Schema(type=types.Type.BOOLEAN),
                            "rpm": types.Schema(type=types.Type.NUMBER),
                        },
                        required=["pump"],
                    ),
                ),
                types.FunctionDeclaration(
                    name="pool_get_status",
                    description="Read the current pool mode, temperatures, pump speeds, features, lights and heater state.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={}),
                ),
                types.FunctionDeclaration(
                    name="pool_system_off",
                    description="Turn off water features, lights, heater and both pumps.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={}),
                ),
                types.FunctionDeclaration(
                    name="pool_open_host_page",
                    description="Open the Pentair IntelliCenter web host page in a browser.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "launch": types.Schema(
                                type=types.Type.BOOLEAN,
                                description="Whether to launch a browser directly on the host system.",
                            ),
                        },
                    ),
                ),
            ])
        ]

    def generate_chat_response(self, api_key: str, prompt: str = "",
                               pool_state: dict | None = None,
                               assistant: dict | None = None,
                               image_bytes: bytes | None = None,
                               image_mime: str = "image/jpeg",
                               provider: str = "google",
                               model: str = "",
                               ollama_url: str = "") -> dict[str, Any]:
        return self._generate(api_key, prompt, None, None, pool_state, assistant,
                              False, image_bytes, image_mime, provider, model, ollama_url)

    def generate_voice_chat_response(self, api_key: str, audio_bytes: bytes | None,
                                     mime_type: str = "audio/webm",
                                     pool_state: dict | None = None,
                                     assistant: dict | None = None,
                                     local: bool = False,
                                     image_bytes: bytes | None = None,
                                     image_mime: str = "image/jpeg",
                                     provider: str = "google",
                                     model: str = "",
                                     ollama_url: str = "") -> dict[str, Any]:
        return self._generate(api_key, "", audio_bytes, mime_type, pool_state,
                              assistant, local, image_bytes, image_mime, provider, model, ollama_url)

    def _generate(self, api_key: str, prompt: str, audio_bytes: bytes | None,
                  mime_type: str | None, pool_state: dict | None,
                  assistant: dict | None = None,
                  local: bool = False,
                  image_bytes: bytes | None = None,
                  image_mime: str = "image/jpeg",
                  provider: str = "google",
                  model: str = "",
                  ollama_url: str = "") -> dict[str, Any]:
        contents = []
        if image_bytes:
            contents.append(
                types.Part.from_bytes(data=image_bytes, mime_type=image_mime or "image/jpeg")
            )
            prompt = (
                "Look at the image from the pool camera. The user may be showing you "
                "something. Describe what you see as Iggy, then answer the request.\n"
                + (prompt or "What am I showing you?")
            )
        if audio_bytes:
            contents.append(types.Part.from_bytes(data=audio_bytes, mime_type=mime_type))
            prompt = (
                "Listen to my spoken request. Transcribe it, reply briefly, and call "
                "the matching pool tool when I ask for a change.\n"
                "Format:\nTRANSCRIPTION: [words]\nRESPONSE: [answer]"
            )
            if local:
                prompt += (
                    "\nThis audio came from the always-on local microphone. If it is "
                    "not addressed to Iggy or is just background conversation, put "
                    "IGNORE on the RESPONSE line and call no tools."
                )
        if pool_state:
            summary = self._state_summary(pool_state)
            prompt = (prompt or "How is the pool?") + "\n\nCurrent pool state:\n" + summary
        contents.append(prompt)

        config = types.GenerateContentConfig(
            system_instruction=self.system_prompt(assistant),
            tools=self._tools(),
            temperature=0.4,
        )
        ai_res = call_ai(
            api_key=api_key,
            contents=contents,
            config=config,
            provider=provider,
            model=model,
            ollama_url=ollama_url,
        )
        text = ai_res.get("text") or ""
        transcription = ""
        if "TRANSCRIPTION:" in text:
            head, _, tail = text.partition("RESPONSE:")
            transcription = head.replace("TRANSCRIPTION:", "").strip()
            text = tail.strip() if tail else text
        action = None
        if ai_res.get("action"):
            call_action = ai_res["action"]
            action = self._action_for(call_action.get("name"), dict(call_action.get("args") or {}))
        return {
            "text": text or "Done.",
            "transcription": transcription,
            "action": action,
        }

    def _action_for(self, name: str, args: dict[str, Any]) -> dict[str, Any] | None:
        action = _TOOL_ACTIONS.get(name)
        if not action:
            return None
        if action == "set_mode":
            payload = {"mode": args.get("mode", "pool")}
        elif action == "set_deck_jet":
            payload = {
                "id": str(args.get("jet", "ne")).lower(),
                "on": args.get("on"),
                "light": args.get("light"),
                "thumper": args.get("thumper"),
            }
        elif action == "set_firebasket":
            spill = str(args.get("spillway") or "both").lower()
            val = bool(args.get("on"))
            payload = {"id": str(args.get("basket", "east")).lower()}
            if args.get("password"):
                payload["password"] = str(args["password"])
            if spill == "pool":
                payload["water"] = val
            elif spill == "spa":
                payload["spa_water"] = val
            elif spill == "flame":
                payload["on"] = val
            elif spill == "lights":
                payload["burner_light"] = val
            else:
                payload["water"] = val
                payload["spa_water"] = val
        elif action == "set_all_features":
            payload = {"on": bool(args.get("on"))}
            if args.get("password"):
                payload["password"] = str(args["password"])
        elif action == "set_blower":
            payload = {"on": bool(args.get("on"))}
        elif action == "set_spillway_color":
            payload = {"effect": args.get("effect")}
        elif action == "set_all_lights":
            payload = {
                "on": args.get("on", True),
                "effect": args.get("effect"),
            }
        elif action == "set_light":
            payload = {
                "body": str(args.get("body", "pool")).lower(),
                "on": args.get("on"),
                "effect": args.get("effect"),
            }
        elif action == "set_heater":
            payload = {
                "on": args.get("on"),
                "setpoint": args.get("setpoint"),
            }
        elif action == "set_pump":
            payload = {
                "pump": str(args.get("pump", "main")).lower(),
                "on": args.get("on"),
                "rpm": args.get("rpm"),
            }
        elif action == "open_host_page":
            payload = {"launch": bool(args.get("launch", False))}
        else:
            payload = {}
        return {"action": action, "payload": payload}

    @staticmethod
    def _state_summary(state: dict[str, Any]) -> str:
        pumps = state.get("pumps", {})
        jets = state.get("deck_jets", {})
        baskets = state.get("firebaskets", {})
        lights = state.get("lights", {})
        heater = state.get("heater", {})
        bodies = state.get("bodies", {})
        blower = state.get("blower", {})
        thermostat = heater.get("thermostat", True)

        def body_line(name):
            body = bodies.get(name, {})
            if thermostat:
                return "%s temp: %s F, setpoint %s F" % (
                    name.capitalize(), body.get("temp"), body.get("setpoint"))
            return "%s temp: %s F" % (name.capitalize(), body.get("temp"))

        lines = [
            "Mode: %s" % state.get("mode"),
            body_line("pool"),
            body_line("spa"),
            "Salt level: %s ppm (%s)" % (
                state.get("chemistry", {}).get("salt"),
                state.get("chemistry", {}).get("source"),
            ),
            "Spillway LED color: %s" % state.get("spillway_effect"),
            "Main pump: %s at %s RPM" % (
                "on" if pumps.get("main", {}).get("on") else "off",
                pumps.get("main", {}).get("rpm"),
            ),
            "Features pump: %s" % (
                "on" if pumps.get("features", {}).get("on") else "off"
            ),
            "Deck jets: %s" % ", ".join(
                "%s=%s" % (key.upper(), "on" if value.get("on") else "off")
                for key, value in jets.items()
            ),
            "Firebaskets: %s" % "; ".join(
                "%s burner=%s, burner lights=%s, pool spillway=%s, spa spillway=%s" % (
                    key.capitalize(),
                    *("on" if value.get(f) else "off"
                      for f in ("on", "burner_light", "water", "spa_water")))
                for key, value in baskets.items()
            ),
            "Lights: pool=%s, spa=%s" % (
                "on" if lights.get("pool", {}).get("on") else "off",
                "on" if lights.get("spa", {}).get("on") else "off",
            ),
            ("Heater: %s at %s F" % ("on" if heater.get("on") else "off", heater.get("setpoint"))
             if thermostat else
             "Heater: %s (simple on/off heater with no thermostat or setpoint)" % (
                 "on" if heater.get("on") else "off")),
            "Spa blower: %s" % ("on" if blower.get("on") else "off"),
            "Panel: %s" % state.get("connection", {}).get("mode"),
        ]
        return "\n".join(lines)
