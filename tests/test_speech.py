"""Real local ASR test using a synthesized English fixture, not a MN benchmark."""
import json
import sys
import time
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
from speech import SpeechRecognizer
from assistant_core import Assistant, AssistantStore

def main():
    fixture = Path(__file__).parent / 'fixtures' / 'time_en.wav'
    started = time.perf_counter()
    result = SpeechRecognizer().transcribe(fixture.read_bytes(), 'audio/wav', 'en')
    result['elapsed_seconds'] = round(time.perf_counter() - started, 2)
    result['fixture_type'] = 'Windows speech synthesis English WAV'
    result['reference_text'] = 'What time is it?'
    with tempfile.TemporaryDirectory(prefix='speech_check_', dir=Path(__file__).parent) as task_tmp:
        assistant = Assistant(AssistantStore(Path(task_tmp) / 'test.db'), provider='rules')
        result['agent_tool'] = assistant.chat(result['text'])['tool']
        assert result['agent_tool'] == 'get_time', result
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print('PASS: synthesized English audio -> real ASR -> local get_time tool')

if __name__ == '__main__':
    main()
