"""Optional real local speech recognition with faster-whisper on CPU.

Models are loaded lazily. By default only existing cached models are used;
there is no automatic download or external audio upload.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import threading
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
if (APP_DIR / ".deps").is_dir():
    sys.path.insert(0, str(APP_DIR / ".deps"))

MAX_AUDIO_BYTES = 10 * 1024 * 1024
MIME_EXTENSIONS = {"audio/webm": ".webm", "video/webm": ".webm", "audio/wav": ".wav",
                   "audio/x-wav": ".wav", "audio/ogg": ".ogg", "audio/mpeg": ".mp3",
                   "audio/mp4": ".m4a", "audio/flac": ".flac"}


class SpeechError(Exception):
    def __init__(self, code, message, status=503):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


class SpeechRecognizer:
    def __init__(self):
        self.model_name = os.environ.get("WHISPER_MODEL", "base")
        override = os.environ.get("LOCAL_WHISPER_MODEL") or os.environ.get("VOICE_MODEL_DIR")
        self.model_path = Path(override).expanduser() if override else APP_DIR / "models" / self.model_name
        self.allow_download = os.environ.get("WHISPER_ALLOW_DOWNLOAD", "0") == "1"
        self._model = None
        self._lock = threading.Lock()
        self._last_error = None

    def status(self):
        try:
            installed = importlib.util.find_spec("faster_whisper") is not None
        except (ImportError, ValueError):
            installed = False
        cached = (self.model_path / "model.bin").is_file()
        ready = installed and (cached or self.allow_download)
        if not installed:
            message = "Дуут танилтын сан суугаагүй. requirements-voice.txt зааврын дагуу суулгана уу. Бичвэрийн горим ажиллана."
        elif not cached and not self.allow_download:
            message = "Whisper загвар татагдаагүй. models/base загварыг бэлдэнэ үү. Бичвэрийн горим ажиллана."
        elif self._model is None:
            message = f"Whisper {self.model_name} is ready. The model loads on the first recording. Spoken commands run automatically during an active session."
        else:
            message = f"Whisper {self.model_name} is ready. Spoken commands run automatically during an active session."
        if self.allow_download and not cached:
            message = "Эхний бичлэгт Whisper загвар интернетээс татагдана; удаж болно. Аудио серверт локал боловсруулагдана."
        return {"speech_mode": "whisper" if ready else "unavailable", "voice_ready": ready,
                "dependencies_available": installed, "model_cached": cached,
                "model_loaded": self._model is not None, "speech_model": self.model_name,
                "speech_languages": ["auto", "en", "mn"],
                "speech_message": self._last_error or message}

    def transcribe(self, audio, content_type, language="auto"):
        mime = content_type.split(";", 1)[0].strip().lower()
        if mime not in MIME_EXTENSIONS:
            raise SpeechError("unsupported_audio", "WebM, WAV, OGG, MP3, M4A эсвэл FLAC аудио хэрэглэнэ үү.", 415)
        if language not in {"auto", "mn", "en"}:
            raise SpeechError("invalid_language", "Дуут танилтын хэл auto, mn эсвэл en байх ёстой.", 400)
        if not audio:
            raise SpeechError("empty_audio", "Аудио хоосон байна. Дахин бичнэ үү.", 400)
        if len(audio) > MAX_AUDIO_BYTES:
            raise SpeechError("audio_too_large", "Аудио 10 MB-аас хэтэрч болохгүй.", 413)
        status = self.status()
        if not status["voice_ready"]:
            raise SpeechError("speech_not_ready", status["speech_message"])
        # Serial inference avoids exhausting RAM on parallel microphone requests.
        with self._lock:
            if self._model is None:
                try:
                    from faster_whisper import WhisperModel
                    source = str(self.model_path) if status["model_cached"] else self.model_name
                    self._model = WhisperModel(source, device="cpu", compute_type="int8",
                                               cpu_threads=2, download_root=str(APP_DIR / "models"),
                                               local_files_only=not self.allow_download)
                except Exception:
                    self._last_error = "Whisper загвар ачаалагдсангүй. Сангийн суулгалт болон локал загварын файлуудыг шалгана уу."
                    raise SpeechError("model_load_failed", self._last_error) from None
            temp_dir = APP_DIR / "data" / "audio_tmp"
            temp_dir.mkdir(parents=True, exist_ok=True)
            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=MIME_EXTENSIONS[mime], dir=temp_dir, delete=False) as stream:
                    temp_path = Path(stream.name)
                    stream.write(audio)
                segments, info = self._model.transcribe(str(temp_path), language=None if language == "auto" else language,
                                                        beam_size=3, vad_filter=True,
                                                        condition_on_previous_text=False)
                if getattr(info, "duration", 0) > 90:
                    raise SpeechError("audio_too_long", "90 секундээс богино бичлэг хэрэглэнэ үү.", 413)
                text = " ".join(segment.text.strip() for segment in segments).strip()
                self._last_error = None
                if not text:
                    raise SpeechError("no_speech", "Яриа танигдсангүй. Нам гүм орчинд ойроос дахин бичнэ үү.", 422)
                return {"text": text, "engine": "faster-whisper", "language": getattr(info, "language", language),
                        "requested_language": language,
                        "model": self.model_name}
            except SpeechError:
                raise
            except Exception:
                raise SpeechError("transcription_failed", "Аудиог уншиж эсвэл таньж чадсангүй. Богино бичлэгийг дахин оролдоно уу.", 422) from None
            finally:
                if temp_path is not None:
                    temp_path.unlink(missing_ok=True)
