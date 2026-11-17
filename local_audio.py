#!/usr/bin/env python3
"""Local microphone and speaker support for the Pool server.

The Raspberry Pi microphone is always listening and the Pi speaker always
speaks Iggy's replies. Browser microphone/speaker selections are additive;
they never replace the local hardware.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import wave
from typing import Any, Callable

LOG = logging.getLogger("pool.audio")

# Microsoft Edge neural voices (free, no key; needs internet). Every English
# voice the service offers, grouped by country. "tld" picks the matching
# Google voice as a fallback. The first male/female per country keep the
# short "<country>-male" / "<country>-female" keys.
_EDGE_COUNTRIES = [
    # key, Google tld, country label, [(name, gender, voice id), ...]
    ("gb", "co.uk", "United Kingdom", [
        ("Ryan", "male", "en-GB-RyanNeural"), ("Sonia", "female", "en-GB-SoniaNeural"),
        ("Thomas", "male", "en-GB-ThomasNeural"), ("Libby", "female", "en-GB-LibbyNeural"),
        ("Maisie", "female (child)", "en-GB-MaisieNeural")]),
    ("us", "com", "United States", [
        ("Guy", "male", "en-US-GuyNeural"), ("Jenny", "female", "en-US-JennyNeural"),
        ("Andrew", "male", "en-US-AndrewNeural"), ("Aria", "female", "en-US-AriaNeural"),
        ("Brian", "male", "en-US-BrianNeural"), ("Ava", "female", "en-US-AvaNeural"),
        ("Christopher", "male", "en-US-ChristopherNeural"), ("Emma", "female", "en-US-EmmaNeural"),
        ("Eric", "male", "en-US-EricNeural"), ("Michelle", "female", "en-US-MichelleNeural"),
        ("Roger", "male", "en-US-RogerNeural"), ("Ana", "female (child)", "en-US-AnaNeural"),
        ("Steffan", "male", "en-US-SteffanNeural"),
        ("Andrew, multilingual", "male", "en-US-AndrewMultilingualNeural"),
        ("Ava, multilingual", "female", "en-US-AvaMultilingualNeural"),
        ("Brian, multilingual", "male", "en-US-BrianMultilingualNeural"),
        ("Emma, multilingual", "female", "en-US-EmmaMultilingualNeural")]),
    ("au", "com.au", "Australia", [
        ("William", "male", "en-AU-WilliamMultilingualNeural"), ("Natasha", "female", "en-AU-NatashaNeural")]),
    ("ca", "ca", "Canada", [
        ("Liam", "male", "en-CA-LiamNeural"), ("Clara", "female", "en-CA-ClaraNeural")]),
    ("ie", "ie", "Ireland", [
        ("Connor", "male", "en-IE-ConnorNeural"), ("Emily", "female", "en-IE-EmilyNeural")]),
    ("nz", "com.au", "New Zealand", [
        ("Mitchell", "male", "en-NZ-MitchellNeural"), ("Molly", "female", "en-NZ-MollyNeural")]),
    ("in", "co.in", "India", [
        ("Prabhat", "male", "en-IN-PrabhatNeural"), ("Neerja", "female", "en-IN-NeerjaNeural"),
        ("Neerja, expressive", "female", "en-IN-NeerjaExpressiveNeural")]),
    ("za", "co.za", "South Africa", [
        ("Luke", "male", "en-ZA-LukeNeural"), ("Leah", "female", "en-ZA-LeahNeural")]),
    ("ng", "com", "Nigeria", [
        ("Abeo", "male", "en-NG-AbeoNeural"), ("Ezinne", "female", "en-NG-EzinneNeural")]),
    ("ke", "com", "Kenya", [
        ("Chilemba", "male", "en-KE-ChilembaNeural"), ("Asilia", "female", "en-KE-AsiliaNeural")]),
    ("tz", "com", "Tanzania", [
        ("Elimu", "male", "en-TZ-ElimuNeural"), ("Imani", "female", "en-TZ-ImaniNeural")]),
    ("sg", "com", "Singapore", [
        ("Wayne", "male", "en-SG-WayneNeural"), ("Luna", "female", "en-SG-LunaNeural")]),
    ("ph", "com", "Philippines", [
        ("James", "male", "en-PH-JamesNeural"), ("Rosa", "female", "en-PH-RosaNeural")]),
    ("hk", "com", "Hong Kong", [
        ("Sam", "male", "en-HK-SamNeural"), ("Yan", "female", "en-HK-YanNeural")]),
]
_OLD_ALIASES = {  # keys used before the full list, kept so saved settings still work
    "us2-male": "en-US-AndrewNeural", "us2-female": "en-US-AriaNeural",
    "gb2-male": "en-GB-ThomasNeural", "gb2-female": "en-GB-LibbyNeural",
}

DEFAULT_SERVER_VOICE = "gb-male"  # Ryan, British male

VOICE_PROFILES = {}
for _key, _tld, _country, _voices in _EDGE_COUNTRIES:
    _seen = set()
    for _name, _gender, _voice in _voices:
        _base = _gender.split()[0]
        _id = "%s-%s" % (_key, _base) if _base not in _seen and "(" not in _gender else _voice
        _seen.add(_base)
        VOICE_PROFILES[_id] = {
            "name": "%s (%s)" % (_name, _gender), "engine": "edge", "voice": _voice,
            "gender": _base, "country": _country, "lang": "en", "tld": _tld, "slow": False}
for _alias, _voice in _OLD_ALIASES.items():
    _match = next(v for v in VOICE_PROFILES.values() if v["voice"] == _voice)
    VOICE_PROFILES[_alias] = dict(_match, hidden=True)

VOICE_PROFILES.update({
    "us": {"name": "Basic Google voice (US)", "lang": "en", "tld": "com", "slow": False},
    "uk": {"name": "Basic Google voice (British)", "lang": "en", "tld": "co.uk", "slow": False},
    "au": {"name": "Basic Google voice (Australian)", "lang": "en", "tld": "com.au", "slow": False},
    "ca": {"name": "Basic Google voice (Canadian)", "lang": "en", "tld": "ca", "slow": False},
    "ie": {"name": "Basic Google voice (Irish)", "lang": "en", "tld": "ie", "slow": False},
    "in": {"name": "Basic Google voice (Indian)", "lang": "en", "tld": "co.in", "slow": False},
    "za": {"name": "Basic Google voice (South African)", "lang": "en", "tld": "co.za", "slow": False},
    "us-slow": {"name": "Basic Google voice (US, slow)", "lang": "en", "tld": "com", "slow": True},
    "uk-slow": {"name": "Basic Google voice (British, slow)", "lang": "en", "tld": "co.uk", "slow": True},
})

_CARD_RE = re.compile(
    r"card\s+(\d+):\s+([^\[]+)\[([^\]]+)\],\s+device\s+(\d+):\s+([^\[]+)\[([^\]]+)\]"
)


def _rms(data: bytes) -> int:
    """RMS of signed 16-bit little-endian PCM without the removed audioop module."""
    count = len(data) // 2
    if count <= 0:
        return 0
    total = 0
    for (value,) in struct.iter_unpack("<h", data[: count * 2]):
        total += value * value
    return int((total / count) ** 0.5)


def _parse_devices(output: str, kind: str) -> list[dict[str, str]]:
    devices = [{"id": "default", "name": "System default", "kind": kind}]
    for match in _CARD_RE.finditer(output or ""):
        card, card_name, card_desc, device, dev_name, dev_desc = match.groups()
        label = "%s %s - %s" % (
            card_name.strip(),
            card_desc.strip(),
            dev_desc.strip() or dev_name.strip(),
        )
        devices.append({
            # Card names are stable across reboots/replugs; numbers are not.
            "id": "plughw:CARD=%s,DEV=%s" % (card_name.strip(), device),
            "name": label,
            "kind": kind,
        })
    return devices


def _pipewire_nodes(media_class: str) -> list[dict[str, str]]:
    """PipeWire sources/sinks as {"id": "pw:<node.name>", "name": description}.

    Going through PipeWire (rather than opening ALSA hardware directly) lets
    the app share the webcam mic and HDMI speaker with a browser on the Pi.
    """
    if not shutil.which("pw-dump"):
        return []
    try:
        dump = json.loads(subprocess.run(["pw-dump"], capture_output=True, text=True,
                                         timeout=4.0).stdout or "[]")
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    nodes = []
    for obj in dump:
        props = (obj.get("info") or {}).get("props") or {}
        if props.get("media.class") != media_class or not props.get("node.name"):
            continue
        nodes.append({
            "id": "pw:" + props["node.name"],
            "name": props.get("node.description") or props.get("node.nick") or props["node.name"],
        })
    return nodes


def _is_pixy(item: dict[str, str]) -> bool:
    text = (item.get("id", "") + " " + item.get("name", "")).lower()
    return "pixy" in text or "emeet" in text


class LocalAudio:
    """Always-on local mic/speaker plus device and voice discovery."""

    def __init__(
        self,
        config: dict[str, Any],
        get_api_key: Callable[[], str],
        process_audio: Callable[[bytes, str], dict[str, Any] | None],
    ) -> None:
        self.config = config
        self.get_api_key = get_api_key
        self.process_audio = process_audio
        self._stop = threading.Event()
        self._mic_thread: threading.Thread | None = None
        self._mic_proc: subprocess.Popen | None = None
        self._speak_lock = threading.Lock()
        self._cache: dict[tuple[str, str], bytes] = {}
        self._speaking_until = 0.0
        self._last_error = ""
        self._last_heard = 0.0
        self._last_spoken = 0.0
        self._active_input = ""
        self._active_output = ""
        self._current_rms = 0
        self._in_speech = False
        self._last_status: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------
    def _local_cfg(self) -> dict[str, Any]:
        return (self.config.get("audio") or {}).get("local") or {}

    def _browser_cfg(self) -> dict[str, Any]:
        return (self.config.get("audio") or {}).get("browser") or {}

    def pi_mic_selected(self) -> bool:
        """Only one mic is active: the Pi webcam mic or the browser's."""
        return str(self._browser_cfg().get("voice_source") or "local") != "browser"

    def pi_speaker_selected(self) -> bool:
        """Only one speaker plays replies: the Pi's or the browser's."""
        return str(self._browser_cfg().get("speaker_dest") or "local") != "browser"

    def _assistant_cfg(self) -> dict[str, Any]:
        return self.config.get("assistant") or {}

    def reconfigure(self) -> None:
        self._cache.clear()
        self._last_status = {}

    def status(self) -> dict[str, Any]:
        mic_ok = bool(shutil.which("pw-record") or shutil.which("arecord"))
        speaker_ok = bool((shutil.which("pw-play") or shutil.which("aplay"))
                          and shutil.which("ffmpeg"))
        return {
            "mic_available": mic_ok,
            "speaker_available": speaker_ok,
            "mic_running": bool(self._mic_thread and self._mic_thread.is_alive()
                                and self._mic_proc is not None),
            "pi_mic_selected": self.pi_mic_selected(),
            "pi_speaker_selected": self.pi_speaker_selected(),
            "speaking": self.is_speaking(),
            "input_device": self._active_input or self._local_cfg().get("input_device", "default"),
            "output_device": self._active_output or self._local_cfg().get("output_device", "default"),
            "rms": self._current_rms,
            "speech_rms": int(self._local_cfg().get("speech_rms", 450)),
            "silence_ms": int(self._local_cfg().get("silence_ms", 1000)),
            "in_speech": self._in_speech,
            "auto_transcribe": bool(self._local_cfg().get("auto_transcribe", False)),
            "last_error": self._last_error,
            "last_heard": self._last_heard,
            "last_spoken": self._last_spoken,
        }

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def start(self) -> None:
        if not (shutil.which("pw-record") or shutil.which("arecord")):
            self._last_error = "neither pw-record nor arecord is installed"
            LOG.warning("Local microphone disabled: %s", self._last_error)
            return
        if self._mic_thread and self._mic_thread.is_alive():
            return
        self._stop.clear()
        self._mic_thread = threading.Thread(target=self._mic_loop, name="local-mic", daemon=True)
        self._mic_thread.start()
        LOG.info("Local microphone listening (always on)")

    def stop(self) -> None:
        self._stop.set()
        proc = self._mic_proc
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass
        if self._mic_thread:
            self._mic_thread.join(timeout=2.0)

    # ------------------------------------------------------------------
    # Device discovery
    # ------------------------------------------------------------------
    @staticmethod
    def _command_output(command: list[str]) -> str:
        try:
            return subprocess.run(
                command, capture_output=True, text=True, timeout=4.0
            ).stdout
        except Exception:
            return ""

    def _resolve_input(self, device: str) -> str:
        sources = _pipewire_nodes("Audio/Source")
        captures = _parse_devices(
            self._command_output(["arecord", "-l"]), "input"
        ) if shutil.which("arecord") else []
        ids = {c["id"] for c in sources + captures}
        # An explicit device is used as long as it is present; a missing one
        # (e.g. the webcam unplugged) falls back to auto-selection.
        if device and device != "default":
            if device in ids or not (device.startswith("pw:") or "CARD=" in device):
                return device
        # Auto: the EMEET PIXY webcam mic first, via PipeWire when it runs.
        for pool in (sources, captures[1:]):
            for item in pool:
                if _is_pixy(item):
                    return item["id"]
        if sources:
            return "pw:"  # PipeWire's default source
        for c in captures[1:]:
            if any(k in c["name"].lower() for k in ("webcam", "usb")):
                return c["id"]
        return captures[1]["id"] if len(captures) > 1 else device or "default"

    @staticmethod
    def _capture_command(device: str, rate: int) -> list[str]:
        if device.startswith("pw:"):
            cmd = ["pw-record", "--rate", str(rate), "--channels", "1",
                   "--format", "s16", "--raw"]
            if device[3:]:
                cmd += ["--target", device[3:]]
            return cmd + ["-"]
        return ["arecord", "-q", "-D", device, "-f", "S16_LE",
                "-r", str(rate), "-c", "1", "-t", "raw"]

    def _resolve_output(self, device: str) -> str:
        if device and device != "default":
            return device
        playbacks = _parse_devices(
            self._command_output(["aplay", "-l"]), "output"
        ) if shutil.which("aplay") else []
        for p in playbacks:
            name_lower = p["name"].lower()
            if "hdmi" in name_lower or "vc4" in name_lower:
                return p["id"]
        return playbacks[1]["id"] if len(playbacks) > 1 else device or "default"

    def _output_candidates(self) -> list[str]:
        configured = str(self._local_cfg().get("output_device") or "default")
        sinks = [item["id"] for item in _pipewire_nodes("Audio/Sink")]
        if sinks and shutil.which("pw-play"):
            # The Pi speaker is always on: the chosen sink if it is present,
            # otherwise PipeWire's default sink.
            candidates = [configured] if configured in sinks else []
            return candidates + ["pw:"]
        playbacks = [
            item["id"] for item in _parse_devices(
                self._command_output(["aplay", "-l"]), "output"
            )
        ] if shutil.which("aplay") else []
        candidates = []
        if configured and configured != "default":
            candidates.append(configured)
        if "default" not in candidates:
            candidates.append("default")
        for device in playbacks:
            if device not in candidates:
                candidates.append(device)
        return candidates

    def devices(self) -> dict[str, Any]:
        sources = _pipewire_nodes("Audio/Source")
        sinks = _pipewire_nodes("Audio/Sink")
        if sources or sinks:
            captures = [{"id": "default", "name": "Automatic (EMEET PIXY webcam mic)",
                         "kind": "input"}] + [dict(s, kind="input") for s in sources]
            playbacks = [{"id": "default", "name": "System default speaker",
                          "kind": "output"}] + [dict(s, kind="output") for s in sinks]
        else:
            captures = _parse_devices(
                self._command_output(["arecord", "-l"]), "input"
            ) if shutil.which("arecord") else []
            playbacks = _parse_devices(
                self._command_output(["aplay", "-l"]), "output"
            ) if shutil.which("aplay") else []
        return {
            "inputs": captures,
            "outputs": playbacks,
            "voices": [
                {"id": key, "name": value["name"],
                 "group": value.get("country") or "Basic Google voices (no gender choice)"}
                for key, value in VOICE_PROFILES.items() if not value.get("hidden")
            ],
            "default_voice": DEFAULT_SERVER_VOICE,
            "local": self.status(),
        }

    # ------------------------------------------------------------------
    # Microphone loop
    # ------------------------------------------------------------------
    def _mic_loop(self) -> None:
        cfg = self._local_cfg()
        device = self._resolve_input(str(cfg.get("input_device") or "default"))
        rate = 16000
        frame_seconds = 0.1
        frame_bytes = int(rate * 2 * frame_seconds)
        while not self._stop.is_set():
            if not self.pi_mic_selected():
                # Browser mic selected: keep the Pi mic fully closed.
                self._current_rms = 0
                self._in_speech = False
                self._stop.wait(1.0)
                continue
            cfg = self._local_cfg()
            wanted = self._resolve_input(str(cfg.get("input_device") or "default"))
            if wanted != device:
                device = wanted
            cmd = self._capture_command(device, rate)
            try:
                proc = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
                )
            except Exception as exc:
                self._last_error = "Microphone open failed: %s" % exc
                LOG.warning(self._last_error)
                self._stop.wait(3.0)
                continue
            self._mic_proc = proc
            if device != self._active_input:
                LOG.info("Local microphone open on %s", device)
            self._active_input = device
            threshold = int(cfg.get("speech_rms", 450))
            silence_needed = int(cfg.get("silence_ms", 1000)) / 1000.0
            min_speech = int(cfg.get("min_speech_ms", 350)) / 1000.0
            max_record = int(cfg.get("max_record_seconds", 8))
            pre_roll: list[bytes] = []
            frames: list[bytes] = []
            speech_seconds = 0.0
            silence_seconds = 0.0
            in_speech = False
            opened_for = str(cfg.get("input_device") or "default")
            frame_count = 0
            while not self._stop.is_set():
                frame_count += 1
                # Reopen when the mic is changed in the Hardware tab.
                if frame_count % 10 == 0 and not self.pi_mic_selected():
                    LOG.info("Browser microphone selected; closing the Pi microphone")
                    break
                if frame_count % 20 == 0 and not in_speech and \
                        str(self._local_cfg().get("input_device") or "default") != opened_for:
                    LOG.info("Local microphone setting changed; reopening")
                    break
                data = proc.stdout.read(frame_bytes) if proc.stdout else b""
                if not data:
                    self._last_error = "Microphone stream ended"
                    break
                if self._last_error == "Microphone stream ended":
                    self._last_error = ""
                if self.is_speaking():
                    pre_roll.clear()
                    frames = []
                    in_speech = False
                    self._in_speech = False
                    speech_seconds = 0.0
                    silence_seconds = 0.0
                    continue
                # Re-read so the sensitivity slider takes effect immediately.
                cfg = self._local_cfg()
                threshold = int(cfg.get("speech_rms", 450))
                silence_needed = max(300, min(10000, int(cfg.get("silence_ms", 1000)))) / 1000.0
                cur_rms = _rms(data)
                self._current_rms = cur_rms
                voiced = cur_rms >= threshold
                if voiced:
                    if not in_speech:
                        in_speech = True
                        frames = list(pre_roll)
                        speech_seconds = frame_seconds * len(frames)
                        silence_seconds = 0.0
                    frames.append(data)
                    speech_seconds += frame_seconds
                elif in_speech:
                    frames.append(data)
                    silence_seconds += frame_seconds
                    if silence_seconds >= silence_needed:
                        if speech_seconds >= min_speech:
                            self._finish_capture(frames, rate)
                        frames = []
                        in_speech = False
                        speech_seconds = 0.0
                        silence_seconds = 0.0
                else:
                    pre_roll.append(data)
                    if len(pre_roll) > 4:
                        pre_roll.pop(0)
                self._in_speech = in_speech
                if in_speech and speech_seconds + silence_seconds > max_record:
                    self._finish_capture(frames, rate)
                    frames = []
                    in_speech = False
                    speech_seconds = 0.0
                    silence_seconds = 0.0
            try:
                proc.terminate()
                proc.wait(timeout=2)  # reap it so no zombie process is left
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            self._mic_proc = None
            if not self._stop.is_set():
                self._stop.wait(1.5)

    def _finish_capture(self, frames: list[bytes], rate: int) -> None:
        if not frames:
            return
        raw = b"".join(frames)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes(raw)
        audio = buffer.getvalue()
        if not self._local_cfg().get("auto_transcribe", False):
            # Local mic is active for live VU metering, but does not consume AI tokens unless auto_transcribe is enabled
            return
        if not self.get_api_key():
            self._last_error = "Local mic is listening; add a server Gemini key to transcribe"
            return
        self._last_heard = time.time()
        try:
            self.process_audio(audio, "audio/wav")
        except Exception as exc:
            self._last_error = "Local voice request failed: %s" % exc
            LOG.exception(self._last_error)

    # ------------------------------------------------------------------
    # Speaker
    # ------------------------------------------------------------------
    def is_speaking(self) -> bool:
        return time.time() < self._speaking_until

    def synthesize(self, text: str, voice_id: str | None = None) -> tuple[bytes | None, str]:
        clean = (text or "").strip()
        if not clean:
            return None, ""
        profile = VOICE_PROFILES.get(str(voice_id or "").strip() or DEFAULT_SERVER_VOICE,
                                     VOICE_PROFILES[DEFAULT_SERVER_VOICE])
        key = (clean, str(voice_id or "us"))
        cached = self._cache.get(key)
        if cached:
            return cached, "audio/mpeg"
        if profile.get("engine") == "edge":
            data = self._synthesize_edge(clean, profile["voice"])
            if data:
                if len(self._cache) > 32:
                    self._cache.pop(next(iter(self._cache)))
                self._cache[key] = data
                return data, "audio/mpeg"
            # Fall back to the Google voice with the same accent.
        try:
            from gtts import gTTS
        except Exception:
            self._last_error = "gTTS is not installed"
            return None, ""
        try:
            audio = io.BytesIO()
            gTTS(
                text=clean,
                lang=profile["lang"],
                tld=profile["tld"],
                slow=bool(profile["slow"]),
            ).write_to_fp(audio)
            data = audio.getvalue()
            if len(self._cache) > 32:
                self._cache.pop(next(iter(self._cache)))
            self._cache[key] = data
            return data, "audio/mpeg"
        except Exception as exc:
            self._last_error = "Speech synthesis failed: %s" % exc
            LOG.warning(self._last_error)
            return None, ""

    def _synthesize_edge(self, text: str, voice: str) -> bytes | None:
        try:
            import asyncio
            import edge_tts
        except Exception:
            self._last_error = "edge-tts is not installed"
            return None

        async def run() -> bytes:
            audio = bytearray()
            async for chunk in edge_tts.Communicate(text, voice).stream():
                if chunk.get("type") == "audio":
                    audio.extend(chunk["data"])
            return bytes(audio)

        try:
            data = asyncio.run(asyncio.wait_for(run(), timeout=20))
            return data or None
        except Exception as exc:
            self._last_error = "Neural voice %s failed: %s" % (voice, exc)
            LOG.warning(self._last_error)
            return None

    def play(self, data: bytes, mime: str = "audio/mpeg", text: str = "") -> None:
        if not data or not (shutil.which("pw-play") or shutil.which("aplay")):
            return
        self._speaking_until = max(self._speaking_until, time.time() + 2.0)
        thread = threading.Thread(
            target=self._play_blocking, args=(data, mime), name="local-speaker", daemon=True
        )
        thread.start()
        if text:
            self._last_spoken = time.time()

    def _play_blocking(self, data: bytes, mime: str) -> None:
        if not self._speak_lock.acquire(blocking=False):
            return
        mp3_path = wav_path = None
        try:
            suffix = ".mp3" if "mpeg" in (mime or "") or "mp3" in (mime or "") else ".wav"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as fh:
                fh.write(data)
                mp3_path = fh.name
            wav_path = mp3_path.rsplit(".", 1)[0] + ".wav"
            convert = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", mp3_path, wav_path],
                capture_output=True, timeout=30.0,
            )
            if convert.returncode != 0 or not os.path.exists(wav_path):
                self._last_error = "ffmpeg could not decode speech audio"
                return
            duration = 0.0
            try:
                with wave.open(wav_path, "rb") as wav:
                    rate = wav.getframerate() or 1
                    duration = wav.getnframes() / float(rate)
            except Exception:
                pass
            self._speaking_until = time.time() + max(1.0, duration + 0.4)
            failures = []
            played = False
            for device in self._output_candidates():
                if device.startswith("pw:"):
                    cmd = ["pw-play"] + (["--target", device[3:]] if device[3:] else []) + [wav_path]
                else:
                    cmd = ["aplay", "-q", "-D", device, wav_path]
                result = subprocess.run(
                    cmd, capture_output=True, timeout=max(15.0, duration + 10.0),
                )
                if result.returncode == 0:
                    self._active_output = device
                    self._last_error = ""
                    played = True
                    break
                detail = (result.stderr or b"").decode("utf-8", "replace").strip()
                failures.append("%s: %s" % (device, detail))
            if not played:
                self._last_error = "Local speakers unavailable: " + "; ".join(failures)
                LOG.warning(self._last_error)
        except Exception as exc:
            self._last_error = "Local speaker failed: %s" % exc
            LOG.warning(self._last_error)
        finally:
            self._speaking_until = time.time() + 0.4
            for path in (mp3_path, wav_path):
                if path and os.path.exists(path):
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
            self._speak_lock.release()


def list_local_audio_inputs():
    inputs = [{"id": "default", "label": "System Default Microphone", "default": True}]
    seen = {"default"}
    try:
        status = subprocess.run(["wpctl", "status"], capture_output=True, text=True, timeout=4).stdout
        in_audio = in_sources = False
        for line in status.splitlines():
            stripped = line.strip()
            if stripped.startswith("Audio"):
                in_audio = True
                continue
            if stripped.startswith("Video"):
                in_audio = in_sources = False
                continue
            if in_audio and stripped.endswith("Sources:"):
                in_sources = True
                continue
            if in_sources and stripped.endswith(("Filters:", "Streams:", "Sinks:")):
                break
            if not in_sources:
                continue
            clean = stripped.lstrip("│├└─ ").strip()
            match = re.match(r"^\*?\s*(\d+)\.\s+(.+?)(?:\s+\[vol:[^\]]*\])?$", clean)
            if not match:
                continue
            node_id, label = match.group(1), match.group(2).strip()
            name = label
            try:
                info = subprocess.run(["wpctl", "inspect", node_id], capture_output=True, text=True, timeout=3).stdout
                name_match = re.search(r'node\.name\s*=\s*"([^"]+)"', info)
                if name_match:
                    name = name_match.group(1)
            except Exception:
                pass
            if name in seen:
                continue
            seen.add(name)
            inputs.append({"id": name, "label": label, "default": clean.startswith("*")})
    except Exception:
        pass
    if len(inputs) <= 1:
        try:
            result = subprocess.run(["arecord", "-l"], capture_output=True, text=True, timeout=4).stdout
            for match in re.finditer(r"card\s+(\d+):\s+([^\[]+)\[([^\]]+)\],\s+device\s+(\d+):\s+([^\[]+)\[([^\]]+)\]", result):
                card, card_name, card_desc, device, dev_name, dev_desc = match.groups()
                hw_id = "hw:%s,%s" % (card, device)
                if hw_id not in seen:
                    seen.add(hw_id)
                    inputs.append({"id": hw_id, "label": "%s %s - %s" % (card_name.strip(), card_desc.strip(), dev_desc.strip() or dev_name.strip()), "default": False})
        except Exception:
            pass
    return inputs


def list_local_audio_outputs():
    outputs = [{"id": "default", "label": "System Default Speaker", "default": True}]
    seen = {"default"}
    try:
        status = subprocess.run(["wpctl", "status"], capture_output=True, text=True, timeout=4).stdout
        in_audio = in_sinks = False
        for line in status.splitlines():
            stripped = line.strip()
            if stripped.startswith("Audio"):
                in_audio = True
                continue
            if stripped.startswith("Video"):
                in_audio = in_sinks = False
                continue
            if in_audio and stripped.endswith("Sinks:"):
                in_sinks = True
                continue
            if in_sinks and stripped.endswith(("Sources:", "Filters:", "Streams:")):
                break
            if not in_sinks:
                continue
            clean = stripped.lstrip("│├└─ ").strip()
            match = re.match(r"^\*?\s*(\d+)\.\s+(.+?)(?:\s+\[vol:[^\]]*\])?$", clean)
            if not match:
                continue
            node_id, label = match.group(1), match.group(2).strip()
            name = label
            try:
                info = subprocess.run(["wpctl", "inspect", node_id], capture_output=True, text=True, timeout=3).stdout
                name_match = re.search(r'node\.name\s*=\s*"([^"]+)"', info)
                if name_match:
                    name = name_match.group(1)
            except Exception:
                pass
            if name in seen:
                continue
            seen.add(name)
            outputs.append({"id": name, "label": label, "default": clean.startswith("*")})
    except Exception:
        pass
    return outputs


def record_local_audio(duration=3.5, device="default"):
    target = str(device or "").replace("local:", "", 1).strip()
    if target in ("", "browser", "local"):
        target = "default"
    tmp_wav = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fh:
            tmp_wav = fh.name
        recorded = False
        if shutil.which("pw-record") and target != "default" and not target.startswith("hw:"):
            cmd = ["pw-record", "--rate", "16000", "--channels", "1"]
            if target:
                cmd += ["--target", target]
            cmd.append(tmp_wav)
            try:
                proc = subprocess.Popen(cmd)
                time.sleep(float(duration))
                proc.send_signal(signal.SIGINT)
                proc.wait(timeout=3)
                if os.path.isfile(tmp_wav) and os.path.getsize(tmp_wav) > 100:
                    recorded = True
            except Exception:
                pass
        if not recorded and shutil.which("arecord"):
            dev_arg = target if target and target != "default" else "default"
            if "PIXY" in dev_arg or "pixy" in dev_arg.lower():
                dev_arg = "dsnoop:CARD=PIXY,DEV=0"
            cmd = ["arecord", "-q", "-d", str(max(1, int(duration))), "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav"]
            if dev_arg:
                cmd += ["-D", dev_arg]
            cmd.append(tmp_wav)
            try:
                subprocess.run(cmd, timeout=duration + 3)
                if os.path.isfile(tmp_wav) and os.path.getsize(tmp_wav) > 100:
                    recorded = True
            except Exception:
                pass
        if recorded and os.path.isfile(tmp_wav):
            with open(tmp_wav, "rb") as fh:
                return fh.read()
    except Exception:
        pass
    finally:
        if tmp_wav and os.path.isfile(tmp_wav):
            try:
                os.remove(tmp_wav)
            except Exception:
                pass
    return None
