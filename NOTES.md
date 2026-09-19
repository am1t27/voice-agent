# Build notes

Working log for the private in-browser voice agent. Numbers here are the only performance claims the README and launch post may use.

## Step 1: fork and first run (2026-09-19)

- Forked `huggingface/transformers.js-examples/conversational-webgpu` via degit into this folder.
- `npm install` clean. Only one copy of `@huggingface/transformers` (3.7.1): kokoro-js's copy is deduped via `resolve.dedupe` in vite.config.js, so the plan's duplicate-transformers risk does not apply.
- Example pins transformers **3.7.1**, not 4.3.0 as researched. Keeping 3.7.1 for v1.
- No LICENSE file ships inside the example folder; the repo root license is Apache-2.0. Credit + license note go in README.
- Dev server runs (`npm run dev`, port 5173). Page loads, models download, app reaches "Start call" ready state. Verified in the Claude browser pane (WebGPU available there). Mic conversation test in real Chrome still pending (needs a human voice).

## Measured: first-load download

| Model | File | Size |
|---|---|---|
| Whisper base (STT) | encoder fp32 + decoder fp32 | 82.5 + 208.5 MB |
| Silero VAD | model.onnx | 2.2 MB |
| Kokoro (TTS) | model.onnx **fp32** | 325.5 MB |
| SmolLM2-1.7B (LLM) | model_q4f16.onnx | 1108.7 MB |
| Tokenizers/configs | misc | ~5 MB |

**Total first load: ~1.73 GB.** Bigger than the plan's ~1.3 GB guess because the example loads Whisper and Kokoro at fp32 on WebGPU, not q8.

Possible later optimization (not v1): q8/q4 dtypes for Whisper/Kokoro would cut several hundred MB, but changes voice/transcription quality; measure before claiming.

## Caching issue found (must re-verify in real Chrome)

In the Claude browser pane, the two large files (Kokoro 325 MB, SmolLM2 1.1 GB) failed to enter the Cache API:

> Unable to add response to browser cache: UnknownError: Failed to execute 'put' on 'Cache': Unexpected internal error.

Small files (~298 MB incl. Whisper) cached fine. If this also happens in real Chrome, "repeat visits load from cache" is only partly true and the loading screen must not claim otherwise. TODO: reload test in real Chrome and record which files re-download.

## Baseline latency (step 2) - PENDING

To measure per machine (Mac M2 8 GB, PC RTX 3050 Ti):
- end of speech to first audio reply, split by stage (Whisper, first LLM token, first TTS audio)
- memory pressure on the Mac during a 5-minute conversation

Will be easy to read once the latency overlay (step 4.2) exists.

## Upstream behavior notes

- Echo handling already exists upstream: worker ignores mic audio while `isPlaying` (worker.js), and the mic stream requests `echoCancellation: true` (App.jsx). Step 5 is a test, probably not a fix.
- VAD is Silero via transformers.js inside the worker, not `@ricky0123/vad-web`.
- No download progress reporting exists; the UI shows only "Loading...". Step 4.3 adds real progress.
- `max_new_tokens` is 1024 upstream; persona step caps it (~100).
