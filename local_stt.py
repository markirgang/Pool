#!/usr/bin/env python3
"""On-Pi speech recognition with faster-whisper.

Cloud transcription through the AI gateway took 5-25 s for a 3 s phrase;
Whisper's tiny English model does the same on a Pi 5 in about 1.3 s with no
network round trip. Models are downloaded once (~75 MB for tiny.en) to the
Hugging Face cache and kept loaded.
"""

from __future__ import annotations

import io
import logging
import threading
import time
import wave
from typing import Any

LOG = logging.getLogger("pool.stt")

# Settings value -> Whisper model name.
MODELS = {
    "local:tiny.en": "tiny.en",
    "local:base.en": "base.en",
}
DEFAULT_MODEL = "local:tiny.en"

# Whisper invents these on noise or silence.
_HALLUCINATIONS = {
    "you", "thank you", "thank you.", "thanks for watching", "thanks for watching!",
    "bye", "bye.", ".", "so", "okay", "uh", "um",
}

_lock = threading.Lock()
_models: dict[str, Any] = {}
_failed: dict[str, str] = {}


def is_local(model: str | None) -> bool:
    return str(model or "") in MODELS


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _model(setting: str):
    name = MODELS.get(setting, MODELS[DEFAULT_MODEL])
    with _lock:
        if name in _models:
            return _models[name]
        if name in _failed:
            raise RuntimeError(_failed[name])
        from faster_whisper import WhisperModel
        started = time.time()
        try:
            model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=4)
        except Exception as exc:
            _failed[name] = "Whisper %s could not load: %s" % (name, exc)
            raise RuntimeError(_failed[name]) from exc
        _models[name] = model
        LOG.info("Loaded on-Pi speech model %s in %.1fs", name, time.time() - started)
        return model


def preload(setting: str) -> None:
    """Load (and warm up) the model in the background so the first request is quick."""
    if not is_local(setting) or not available():
        return

    def run() -> None:
        try:
            import numpy as np
            model = _model(setting)
            with _lock:
                list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en",
                                      beam_size=1, without_timestamps=True)[0])
        except Exception as exc:
            LOG.warning("On-Pi speech model not ready: %s", exc)
    threading.Thread(target=run, name="stt-preload", daemon=True).start()


def _samples(audio: bytes):
    """16-bit PCM WAV -> float32 mono samples at the WAV's rate (Whisper wants 16 kHz)."""
    import numpy as np
    with wave.open(io.BytesIO(audio), "rb") as wav:
        rate = wav.getframerate()
        channels = wav.getnchannels()
        if wav.getsampwidth() != 2:
            raise ValueError("expected 16-bit audio")
        data = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    samples = data.astype(np.float32) / 32768.0
    if rate != 16000:
        count = int(len(samples) * 16000 / rate)
        samples = np.interp(np.linspace(0, len(samples) - 1, count),
                            np.arange(len(samples)), samples).astype(np.float32)
    return samples


def transcribe(audio: bytes, mime_type: str, setting: str = DEFAULT_MODEL) -> str:
    """Speech to text on the Pi. Raises if the audio or model can't be used."""
    if "wav" not in (mime_type or "").lower():
        # Browser recordings are webm/ogg; decoding those needs ffmpeg.
        audio = _to_wav(audio)
    samples = _samples(audio)
    model = _model(setting)
    with _lock:
        segments, _ = model.transcribe(
            samples, language="en", beam_size=1, without_timestamps=True,
            condition_on_previous_text=False, hotwords="Iggy", vad_filter=False)
        parts = [s for s in segments if s.no_speech_prob < 0.6]
    text = " ".join(s.text.strip() for s in parts).strip()
    if text.lower().strip(" !?") in _HALLUCINATIONS:
        return ""
    return text


def _to_wav(audio: bytes) -> bytes:
    import subprocess
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"],
        input=audio, capture_output=True, timeout=15)
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError("could not decode the recording")
    return result.stdout
