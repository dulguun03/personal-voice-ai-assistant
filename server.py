
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

APP_DIR = Path(__file__).resolve().parent
if (APP_DIR / ".deps").is_dir():
    sys.path.insert(0, str(APP_DIR / ".deps"))

from assistant_core import Assistant, AssistantStore
from speech import MAX_AUDIO_BYTES, SpeechError, SpeechRecognizer


def load_env_file(path):
    """Small explicit dotenv subset; existing environment always takes priority."""
    allowed = {"AGENT_PROVIDER", "OPENAI_API_KEY", "OPENAI_MODEL", "OLLAMA_URL", "OLLAMA_MODEL",
               "WHISPER_MODEL", "LOCAL_WHISPER_MODEL", "VOICE_MODEL_DIR", "WHISPER_ALLOW_DOWNLOAD"}
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name, value = name.strip(), value.strip()
        if name in allowed:
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(name, value)


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, assistant, speech):
        super().__init__(address, Handler)
        self.assistant, self.speech = assistant, speech


class Handler(BaseHTTPRequestHandler):
    server_version = "PersonalVoiceAssistant/1.0"

    def log_message(self, format, *args):
        # Avoid logging user text, audio, or secret-bearing query strings.
        print(f"HTTP {self.command} {args[1] if len(args) > 1 else ''}")

    def _respond(self, status, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _error(self, status, code, message):
        self._respond(status, {"error": code, "message": message})

    def _local_request(self):
        host = self.headers.get("Host", "")
        port = self.server.server_port
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if host not in allowed:
            self._error(403, "invalid_host", "Зөвхөн localhost хаягаар хандана уу.")
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in {"http://" + item for item in allowed}:
            self._error(403, "invalid_origin", "Өөр вэб сайтаас илгээсэн хүсэлтийг зөвшөөрөхгүй.")
            return False
        return True

    def _body(self, maximum):
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("Chunked хүсэлтийг дэмжихгүй.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Content-Length буруу байна.") from None
        if length <= 0:
            raise ValueError("Хүсэлтийн агуулга хоосон байна.")
        if length > maximum:
            raise SpeechError("request_too_large", "Хүсэлтийн агуулга зөвшөөрсөн хэмжээнээс том байна.", 413)
        self.connection.settimeout(30)
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError("Хүсэлтийн агуулга дутуу ирлээ.")
        return raw

    def do_GET(self):
        if not self._local_request():
            return
        path = urlsplit(self.path).path
        if path == "/api/status":
            try:
                agent = self.server.assistant.status()
                voice = self.server.speech.status()
                self._respond(200, {**agent, **voice, **self.server.assistant.store.data(),
                                    "message": agent["message"] + " " + voice["speech_message"]})
            except sqlite3.Error:
                self._error(500, "storage_error", "Өгөгдлийн санг уншиж чадсангүй.")
            return
        if path == "/api/data":
            try:
                self._respond(200, self.server.assistant.store.data())
            except sqlite3.Error:
                self._error(500, "storage_error", "Өгөгдлийн санг уншиж чадсангүй.")
            return
        if path.startswith("/api/"):
            self._error(404, "not_found", "API хаяг олдсонгүй.")
            return
        web_root = (APP_DIR / "web").resolve()
        try:
            decoded = unquote(path)
            if "\\" in decoded or "\x00" in decoded:
                raise ValueError()
            target = (web_root / ("index.html" if decoded == "/" else decoded.lstrip("/"))).resolve()
            target.relative_to(web_root)
            if not target.is_file():
                self._error(404, "not_found", "Файл олдсонгүй.")
                return
            mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if mime.startswith("text/") or mime in {"application/javascript", "application/json"}:
                mime += "; charset=utf-8"
            self._respond(200, target.read_bytes(), mime)
        except (ValueError, OSError):
            self._error(403, "forbidden", "Энэ файлд хандах боломжгүй.")

    def do_POST(self):
        if not self._local_request():
            return
        parsed = urlsplit(self.path)
        try:
            if parsed.path == "/api/transcribe":
                language = parse_qs(parsed.query).get("language", ["auto"])[0]
                audio = self._body(MAX_AUDIO_BYTES)
                result = self.server.speech.transcribe(audio, self.headers.get("Content-Type", ""), language)
                self._respond(200, result)
            elif parsed.path == "/api/chat":
                if self.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
                    self._error(415, "json_required", "application/json агуулга хэрэглэнэ үү.")
                    return
                payload = json.loads(self._body(32 * 1024))
                if not isinstance(payload, dict) or set(payload) != {"text"}:
                    raise ValueError("{text: бичвэр} бүтэцтэй JSON илгээнэ үү.")
                self._respond(200, self.server.assistant.chat(payload["text"]))
            elif parsed.path == "/api/confirm":
                self._error(409, "no_pending_confirmation", "Хүлээгдэж буй баталгаажуулалт алга. Тэмдэглэл, даалгаврыг тодорхой командын дагуу хадгална.")
            else:
                self._error(404, "not_found", "API хаяг олдсонгүй.")
        except SpeechError as error:
            self._error(error.status, error.code, error.message)
        except (ValueError, UnicodeError, TypeError) as error:
            self._error(400, "invalid_request", str(error) if not isinstance(error, json.JSONDecodeError) else "JSON бүтэц буруу байна.")
        except sqlite3.Error:
            self._error(500, "storage_error", "Өгөгдлийн санд хадгалж чадсангүй. Дахин оролдоно уу.")
        except (TimeoutError, OSError):
            self._error(408, "request_failed", "Хүсэлт бүрэн ирсэнгүй эсвэл хугацаа дууслаа.")
        except Exception:
            self._error(500, "internal_error", "Серверийн дотоод алдаа гарлаа. Тохиргоогоо шалгана уу.")


def main():
    parser = argparse.ArgumentParser(description="Personal Voice AI Assistant local prototype")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--db", type=Path, default=APP_DIR / "data" / "assistant.db")
    parser.add_argument("--no-browser", action="store_true", help="Accepted for launchers; server does not open a browser.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")
    load_env_file(APP_DIR / ".env")
    server = LocalServer(("127.0.0.1", args.port), Assistant(AssistantStore(args.db)), SpeechRecognizer())
    print(f"Personal Voice AI Assistant: http://127.0.0.1:{args.port}")
    print("Stop with Ctrl+C. Local tools need no API key.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
