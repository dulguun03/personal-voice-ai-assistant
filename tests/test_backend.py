"""Reproducible standard-library backend checks.

Run from app/: python tests/test_backend.py
The suite creates and removes its own temporary SQLite database, never changes
the user's assistant.db, never downloads a model, and never calls a remote API.
Real network checks use an ephemeral localhost port. AI responses are mocked.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

from assistant_core import Assistant, AssistantStore, ProviderError
from server import LocalServer
from speech import SpeechRecognizer

CHECKS = []


def check(condition, label, category="real"):
    CHECKS.append({"name": label, "category": category, "passed": bool(condition)})
    if not condition:
        raise AssertionError(label)
    print("PASS", label)


def run_checks():
    # Keep temporary data within the delivered project, including on sandboxed Windows.
    with TemporaryDirectory(prefix="backend-test-", dir=Path(__file__).resolve().parent) as directory:
        db = Path(directory) / "test.db"
        store = AssistantStore(db)
        assistant = Assistant(store, provider="rules")
        response = assistant.chat('Тэмдэглэл нэм: Маргааш "тайлан" хэвлэх; DROP TABLE notes;')
        check(response["tool"] == "add_note" and '"тайлан"' in response["notes"][0]["content"],
              "Unicode, quotation marks and SQL payload are stored literally")
        check(AssistantStore(db).data()["notes"] == response["notes"], "SQLite persists across a new store instance")
        response = assistant.chat("Даалгавар нэм: Багшид загвараа үзүүлэх")
        check(response["tool"] == "add_task" and response["tasks"][0]["done"] is False, "Mongolian task creation")
        check(assistant.chat("Тэмдэглэл харуул")["tool"] == "list_notes", "List notes")
        check(assistant.chat("Даалгавар харуул")["tool"] == "list_tasks", "List tasks")
        check(assistant.chat("Ажлууд харуул")["tool"] == "list_tasks", "Plural task list alias")
        check("+08:00" in assistant.chat("Одоо хэдэн цаг вэ?")["reply"], "Ulaanbaatar UTC+08:00 time")
        check(assistant.chat("Тэмдэглэл нэм")["tool"] is None, "Missing note content asks for clarification")
        check(assistant.chat("Ажил нэм")["tool"] is None, "Missing work content asks for clarification")
        for label, payload in [("Empty input", ""), ("Nonstring input", 123), ("Oversized input", "x" * 4001)]:
            try:
                assistant.chat(payload)
            except ValueError:
                check(True, label + " rejected")
            else:
                check(False, label + " rejected")
        try:
            assistant.execute_tool("shell", {"command": "dir"})
        except ValueError:
            check(True, "Unknown tool blocked")
        else:
            check(False, "Unknown tool blocked")

        response = assistant.chat('Jarvis, please take a note: Bring "Project A" tomorrow.')
        check(response["tool"] == "add_note" and response["notes"][0]["content"] == 'Bring "Project A" tomorrow.',
              "Spoken English note preserves capitalization, quotation marks and punctuation")
        check(response["language"] == "en" and response["reply"].startswith("Saved note"), "English command gets English acknowledgement")
        response = assistant.chat("Jarvis, remember to prepare the project demonstration tomorrow.")
        check(response["tool"] == "add_note" and response["notes"][0]["content"] == "to prepare the project demonstration tomorrow.",
              "Remember command saves a note without scheduling a reminder")
        response = assistant.chat("Hey Jarvis, add a task prepare the slides")
        check(response["tool"] == "add_task" and response["tasks"][0]["title"] == "prepare the slides", "Spoken English task creation")
        response = assistant.chat("Jarvis add print the report to my tasks")
        check(response["tool"] == "add_task" and response["tasks"][0]["title"] == "print the report", "English add-to-my-tasks command")
        check(assistant.chat("Jarvis, what are my tasks?")["tool"] == "list_tasks", "Spoken English task question")
        check(assistant.chat("Jarvis read my notes")["tool"] == "list_notes", "Spoken English read-notes command")
        response = assistant.chat("Жарвис аа, what time is it?")
        check(response["language"] == "en" and response["tool"] == "get_time" and response["reply"].startswith("It is"),
              "Invocation name does not override the actual English command language")
        response = assistant.chat("Жарвис аа, тэмдэглэл нэм Маргааш Тайлан хэвлэх")
        check(response["language"] == "mn" and response["notes"][0]["content"] == "Маргааш Тайлан хэвлэх", "Mongolian spoken note without colon")
        response = assistant.chat("Жарвис, тэмдэглэл Маргааш тайлангаа хэвлэх хадгалаарай")
        check(response["tool"] == "add_note" and response["notes"][0]["content"] == "Маргааш тайлангаа хэвлэх", "Mongolian save-note suffix")
        response = assistant.chat("Жарвис аа Маргааш загвараа үзүүлэх гэж тэмдэглэл хадгалаарай")
        check(response["tool"] == "add_note" and response["notes"][0]["content"] == "Маргааш загвараа үзүүлэх", "Mongolian content-first save-note command")
        response = assistant.chat("Жарвис, даалгавар Маргааш тайлангаа хэвлэх нэмээрэй")
        check(response["tool"] == "add_task" and response["tasks"][0]["title"] == "Маргааш тайлангаа хэвлэх", "Mongolian content-before-add task command")
        check(assistant.chat("Жарвис аа тэмдэглэл унш")["tool"] == "list_notes", "Mongolian spoken read-notes command")
        response = assistant.chat("Jarvis remind me to prepare the report")
        check(response["tool"] == "add_task" and "does not schedule" in response["reply"], "Reminder phrasing saves only a task and explains the limit")
        before = store.data()
        response = assistant.chat("Jarvis, how do I add a task?")
        check(response["tool"] is None and store.data() == before, "A question about task creation performs no write")
        response = assistant.chat("Jarvis, please take a note")
        check(response["tool"] is None and response["reply"].startswith("What would"), "Incomplete spoken note asks for content")
        before = store.data()
        response = assistant.chat("Jarvis, open the calculator")
        check(response["tool"] is None and store.data() == before, "Unsupported spoken command produces help without effects")

        # Verify language forwarding without pretending this is an ASR accuracy test.
        class FakeSpeechModel:
            def __init__(self):
                self.options = None

            def transcribe(self, audio_path, **options):
                self.options = options
                return iter([SimpleNamespace(text="What time is it?")]), SimpleNamespace(duration=2, language="en")

        speech = SpeechRecognizer()
        speech._model = FakeSpeechModel()
        speech.status = lambda: {"voice_ready": True, "model_cached": True}
        audio_dir = APP_DIR / "data" / "audio_tmp"
        existing_audio = set(audio_dir.glob("*")) if audio_dir.exists() else set()
        result = speech.transcribe(b"mock audio bytes", "audio/wav", "auto")
        check(speech._model.options["language"] is None, "Auto ASR passes None to language detector", "mocked_speech")
        check(result["language"] == "en" and result["requested_language"] == "auto", "Auto ASR reports the detected language", "mocked_speech")
        check(set(audio_dir.glob("*")) == existing_audio, "Temporary audio is deleted after transcription", "mocked_speech")
        speech.transcribe(b"mock audio bytes", "audio/wav", "mn")
        check(speech._model.options["language"] == "mn", "Explicit ASR language selection still works", "mocked_speech")

        # A fake credential is used only with an injected transport; no HTTP request is made.
        with patch.dict(os.environ, {"OPENAI_API_KEY": "fake-test-only", "OLLAMA_URL": "http://127.0.0.1:11434"}):
            attempts = []

            def fake_openai(url, body, headers=None):
                attempts.append(deepcopy(body))
                if len(attempts) == 1:
                    return {"output": [{"type": "function_call", "name": "add_note",
                                        "arguments": json.dumps({"content": "AI тест"}),
                                        "call_id": "call1", "id": "fc1"}]}
                return {"output": [{"type": "message", "content": [{"type": "output_text", "text": "Хадгаллаа"}]}]}

            response = Assistant(store, provider="openai", transport=fake_openai).chat("Тэмдэглэл нэм: AI тест")
            check(response["mode"] == "openai" and response["tool"] == "add_note"
                  and response["notes"][0]["content"] == "AI тест", "OpenAI Responses tool loop", "mocked_ai")
            check(attempts[1]["input"][-1]["type"] == "function_call_output", "OpenAI tool result returned to model", "mocked_ai")
            check(attempts[0]["parallel_tool_calls"] is False and attempts[0]["store"] is False,
                  "OpenAI serial tools and response storage setting", "mocked_ai")
            unauthorized_attempts = []

            def fake_unauthorized(url, body, headers=None):
                unauthorized_attempts.append(deepcopy(body))
                if len(unauthorized_attempts) == 1:
                    return {"output": [{"type": "function_call", "name": "add_note",
                                        "arguments": '{"content":"bad"}', "call_id": "bad"}]}
                return {"output": [{"type": "message", "content": [{"type": "output_text", "text": "Тодруулна уу"}]}]}

            before = len(store.list_notes())
            Assistant(store, provider="openai", transport=fake_unauthorized).chat("Сайн уу")
            check(len(store.list_notes()) == before, "LLM unsolicited write blocked", "mocked_ai")

            def fake_failure(url, body, headers=None):
                raise ProviderError("offline")

            response = Assistant(store, provider="openai", transport=fake_failure).chat("Тэмдэглэл нэм: давталтгүй")
            check(response["warning"] == "offline" and len(store.list_notes()) == before,
                  "Provider failure never replays a local write", "mocked_ai")
            duplicate_attempts = []

            def fake_duplicate(url, body, headers=None):
                duplicate_attempts.append(deepcopy(body))
                if len(duplicate_attempts) <= 2:
                    return {"output": [{"type": "function_call", "name": "add_note",
                                        "arguments": '{"content":"single"}',
                                        "call_id": str(len(duplicate_attempts))}]}
                raise ProviderError("followup offline")

            response = Assistant(store, provider="openai", transport=fake_duplicate).chat("Тэмдэглэл нэм: single")
            check(len(store.list_notes()) == before + 1 and "single" in response["reply"],
                  "Duplicate write blocked and success preserved after followup failure", "mocked_ai")
            attempts = []

            def fake_ollama(url, body, headers=None):
                attempts.append(deepcopy(body))
                if len(attempts) == 1:
                    return {"message": {"role": "assistant", "content": "", "tool_calls": [
                        {"function": {"name": "list_tasks", "arguments": {}}}]}}
                return {"message": {"role": "assistant", "content": "Жагсаалт бэлэн"}}

            response = Assistant(store, provider="ollama", transport=fake_ollama).chat("Даалгавар харуул")
            check(response["tool"] == "list_tasks" and attempts[1]["messages"][-1]["role"] == "tool",
                  "Ollama tool result loop", "mocked_ai")
            attempts = []
            response = Assistant(store, provider="openai", transport=fake_openai).chat('Jarvis take a note Preserve "THIS" exactly.')
            check(response["language"] == "en" and response["reply"].startswith("Saved note")
                  and response["notes"][0]["content"] == 'Preserve "THIS" exactly.',
                  "Remote write acknowledgement stays English and stores original user content", "mocked_ai")

        server = LocalServer(("127.0.0.1", 0), assistant, SpeechRecognizer())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = "http://127.0.0.1:" + str(server.server_port)

        def http(path, payload=None, headers=None):
            request = Request(base + path,
                              data=json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None,
                              headers={"Content-Type": "application/json", **(headers or {})})
            try:
                with urlopen(request, timeout=5) as response:
                    return response.status, json.loads(response.read())
            except HTTPError as error:
                return error.code, json.loads(error.read())

        try:
            check(http("/api/status")[0] == 200, "HTTP status route", "real_http")
            check(http("/api/chat", {"text": "Тэмдэглэл харуул"})[1]["tool"] == "list_notes", "HTTP chat route", "real_http")
            check(http("/api/chat", {"bad": "invalid"})[0] == 400, "HTTP malformed JSON schema rejected", "real_http")
            check(http("/api/chat", {"text": "time"}, {"Origin": "https://untrusted.invalid"})[0] == 403,
                  "Cross-site mutation blocked", "real_http")
            check(http("/../assistant_core.py")[0] == 403, "Static path traversal blocked", "real_http")
            check(http("/.env")[0] == 404, "Private environment file inaccessible", "real_http")
            check(http("/api/confirm", {"confirmation_id": "none"})[0] == 409, "No invented pending confirmation", "real_http")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def main():
    failure = None
    try:
        run_checks()
    except Exception as error:
        failure = f"{type(error).__name__}: {error}"
        traceback.print_exc()
    categories = sorted({item["category"] for item in CHECKS})
    report = {
        "generated_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "suite": "Jarvis bilingual spoken commands and HTTP; AI/speech transport mocks",
        "command": "python tests/test_backend.py",
        "python_version": sys.version.split()[0],
        "status": "passed" if failure is None else "failed",
        "passed": sum(item["passed"] for item in CHECKS),
        "total": len(CHECKS),
        "categories": {category: sum(item["category"] == category for item in CHECKS) for category in categories},
        "checks": CHECKS,
        "failure": failure,
        "limitations": [
            "OpenAI and Ollama requests use mock transports; no real remote provider or paid API was called.",
            "Speech recognition is outside this suite; actual ASR evidence is recorded separately.",
            "The suite creates a temporary database and never modifies app/data/assistant.db.",
        ],
    }
    destination = APP_DIR / "jarvis_test_results.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"TOTAL PASS {report['passed']}/{report['total']}; results: jarvis_test_results.json")
    return 0 if failure is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
