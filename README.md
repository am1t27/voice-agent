# The Narrator

A voice agent that runs entirely in your browser. You talk, a dramatic movie-trailer narrator answers, and after the models finish loading you can turn off your wifi and keep talking. There is no backend, no API key and no account: speech detection, speech recognition, the language model and the voice all run on your GPU through WebGPU.

## How it works

```
your mic
   |
   v
Silero VAD ---- detects when you start and stop speaking
   |
   v
Whisper base ---- turns your speech into text          \
   |                                                    |
   v                                                    | all inside
SmolLM2-1.7B ---- writes the narrator's reply           | the browser,
   |                                                    | on your GPU
   v                                                    |
Kokoro TTS ---- speaks it, streaming as text arrives   /
   |
   v
your speakers
```

The page itself proves the privacy claim instead of asserting it: a panel counts every network request the page makes after the models load (measured with `PerformanceObserver` in both the page and the worker). During a conversation it stays at zero. There are no analytics scripts.

## Numbers

- First load downloads about **1.7 GB** of models from the Hugging Face CDN: SmolLM2-1.7B (q4f16, 1109 MB), Kokoro (fp32, 326 MB), Whisper base (fp32, 291 MB), plus tokenizers.
- The loading screen shows per-model progress and, once ready, how long loading took on your machine.
- A latency readout shows, for the last reply, the time from the end of your sentence to the first spoken audio, split into transcription and first-token time.
- Reply latency on reference machines: to be measured (M2 MacBook Air 8 GB, RTX 3050 Ti laptop).

## Browser support

WebGPU is required: Chrome or Edge on desktop, Safari 26+, Firefox on Windows or Apple Silicon. Unsupported browsers get a clear message instead of a silent failure.

## Honest limitations

- SmolLM2-1.7B is a small model. It gets facts wrong and rambles; the persona and a 100-token reply cap are there to make that entertaining rather than to hide it.
- The first load is large. It happens once per browser (subject to browser cache behavior for files over ~300 MB, still being verified).
- Use headphones: without them the agent can hear itself through your speakers.

## Run it locally

```
npm install
npm run dev
```

## Credits

Forked from [transformers.js-examples/conversational-webgpu](https://github.com/huggingface/transformers.js-examples) by Hugging Face (Apache-2.0). Models: [SmolLM2](https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct) (HuggingFaceTB), [whisper-base](https://huggingface.co/onnx-community/whisper-base) (OpenAI, ONNX by onnx-community), [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), [Silero VAD](https://huggingface.co/onnx-community/silero-vad). Built with [Transformers.js](https://github.com/huggingface/transformers.js) and [kokoro-js](https://www.npmjs.com/package/kokoro-js).
