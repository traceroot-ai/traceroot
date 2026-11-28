"""Tiny WAV files built in code, for the audio estimation tests."""

import io
import wave


def make_wav(seconds: float = 1.0, *, rate: int = 16_000) -> bytes:
    """A complete mono 16-bit PCM WAV file of silence, ``seconds`` long."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"\x00\x00" * int(seconds * rate))
    return buf.getvalue()
