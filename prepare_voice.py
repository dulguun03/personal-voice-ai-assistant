
import os
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent
sys.path.insert(0, str(APP / '.deps'))
os.environ.setdefault('HF_HOME', str(APP / 'models' / '.hf-cache'))
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')

def main():
    from huggingface_hub import snapshot_download
    from faster_whisper import WhisperModel
    target = APP / 'models' / 'base'
    target.mkdir(parents=True, exist_ok=True)
    print('Downloading Whisper base multilingual model to', target, flush=True)
    snapshot_download('Systran/faster-whisper-base', local_dir=str(target),
                      allow_patterns=['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*', 'preprocessor_config.json'])
    WhisperModel(str(target), device='cpu', compute_type='int8')
    print('Whisper base loaded successfully on CPU. Voice setup complete.', flush=True)

if __name__ == '__main__':
    main()
