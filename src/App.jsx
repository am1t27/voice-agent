import { useEffect, useState, useRef } from "react";
import { PhoneOff, ChevronDown, ShieldCheck, Timer } from "lucide-react";
import { INPUT_SAMPLE_RATE } from "./constants";
import { PERSONA } from "./persona";

import WORKLET from "./play-worklet.js";

const HAS_WEBGPU = typeof navigator !== "undefined" && !!navigator.gpu;

function formatMB(bytes) {
  return (bytes / 1e6).toFixed(1);
}

export default function App() {
  const [callStartTime, setCallStartTime] = useState(null);
  const [callStarted, setCallStarted] = useState(false);
  const [playing, setPlaying] = useState(false);

  const [voice, setVoice] = useState(PERSONA.voice);
  const [voices, setVoices] = useState([]);

  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [listeningScale, setListeningScale] = useState(1);
  const [speakingScale, setSpeakingScale] = useState(1);
  const [ripples, setRipples] = useState([]);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [elapsedTime, setElapsedTime] = useState("00:00");

  // Loading screen state: per-file download progress from the worker
  const [loadingFiles, setLoadingFiles] = useState({});
  const [loadSeconds, setLoadSeconds] = useState(null);
  const loadStartRef = useRef(performance.now());

  // Privacy panel state: network activity since models finished loading
  const [netRequests, setNetRequests] = useState(0);
  const [netBytes, setNetBytes] = useState(0);

  // Latency readout: last turn's per-stage times from the worker
  const [timings, setTimings] = useState(null);

  const worker = useRef(null);

  const micStreamRef = useRef(null);
  const node = useRef(null);

  useEffect(() => {
    worker.current?.postMessage({
      type: "set_voice",
      voice,
    });
  }, [voice]);

  useEffect(() => {
    if (!callStarted) {
      // Reset worker state after call ends
      worker.current?.postMessage({
        type: "end_call",
      });
    }
  }, [callStarted]);

  useEffect(() => {
    if (callStarted && callStartTime) {
      const interval = setInterval(() => {
        const diff = Math.floor((Date.now() - callStartTime) / 1000);
        const minutes = String(Math.floor(diff / 60)).padStart(2, "0");
        const seconds = String(diff % 60).padStart(2, "0");
        setElapsedTime(`${minutes}:${seconds}`);
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setElapsedTime("00:00");
    }
  }, [callStarted, callStartTime]);

  // Count main-thread network requests after the models are ready.
  // The worker reports its own requests separately; together they
  // should stay at zero during a conversation.
  useEffect(() => {
    if (!ready) return;
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) {
        setNetRequests((prev) => prev + entries.length);
        setNetBytes(
          (prev) =>
            prev + entries.reduce((acc, e) => acc + (e.transferSize ?? 0), 0),
        );
      }
    });
    observer.observe({ entryTypes: ["resource"] });
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    if (!HAS_WEBGPU) return;
    worker.current ??= new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });

    const onMessage = ({ data }) => {
      if (data.error) {
        return onError(data.error);
      }

      switch (data.type) {
        case "loading":
          if (
            data.data?.file &&
            ["initiate", "progress", "done"].includes(data.data.status)
          ) {
            const { name, file, loaded = 0, total = 0, status } = data.data;
            const key = `${name}/${file}`;
            setLoadingFiles((prev) => ({
              ...prev,
              [key]: {
                name,
                file,
                loaded: status === "done" ? (prev[key]?.total ?? loaded) : loaded,
                total: Math.max(total, prev[key]?.total ?? 0),
                done: status === "done",
              },
            }));
          }
          break;
        case "status":
          if (data.status === "recording_start") {
            setIsListening(true);
            setIsSpeaking(false);
          } else if (data.status === "recording_end") {
            setIsListening(false);
          } else if (data.status === "ready") {
            setVoices(data.voices);
            setReady(true);
            setLoadSeconds(
              ((performance.now() - loadStartRef.current) / 1000).toFixed(1),
            );
          }
          break;
        case "network":
          setNetRequests((prev) => prev + data.entries.length);
          setNetBytes(
            (prev) =>
              prev + data.entries.reduce((acc, e) => acc + e.bytes, 0),
          );
          break;
        case "timings":
          setTimings(data.timings);
          break;
        case "output":
          if (!playing) {
            node.current?.port.postMessage(data.result.audio);
            setPlaying(true);
            setIsSpeaking(true);
            setIsListening(false);
          }
          break;
      }
    };
    const onError = (err) => setError(err.message);

    worker.current.addEventListener("message", onMessage);
    worker.current.addEventListener("error", onError);

    return () => {
      worker.current.removeEventListener("message", onMessage);
      worker.current.removeEventListener("error", onError);
    };
  }, []);

  useEffect(() => {
    if (!callStarted) return;

    let worklet;
    let inputAudioContext;
    let source;
    let ignore = false;

    let outputAudioContext;
    const audioStreamPromise = Promise.resolve(micStreamRef.current);

    audioStreamPromise
      .then(async (stream) => {
        if (ignore) return;

        inputAudioContext = new (
          window.AudioContext || window.webkitAudioContext
        )({
          sampleRate: INPUT_SAMPLE_RATE,
        });

        const analyser = inputAudioContext.createAnalyser();
        analyser.fftSize = 256;
        source = inputAudioContext.createMediaStreamSource(stream);
        source.connect(analyser);

        const inputDataArray = new Uint8Array(analyser.frequencyBinCount);

        function calculateRMS(array) {
          let sum = 0;
          for (let i = 0; i < array.length; ++i) {
            const normalized = array[i] / 128 - 1;
            sum += normalized * normalized;
          }
          const rms = Math.sqrt(sum / array.length);
          return rms;
        }

        await inputAudioContext.audioWorklet.addModule(
          new URL("./vad-processor.js", import.meta.url),
        );
        worklet = new AudioWorkletNode(inputAudioContext, "vad-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "discrete",
        });

        source.connect(worklet);
        worklet.port.onmessage = (event) => {
          const { buffer } = event.data;
          worker.current?.postMessage({ type: "audio", buffer });
        };

        outputAudioContext = new AudioContext({
          sampleRate: 24000,
        });
        outputAudioContext.resume();

        const blob = new Blob([`(${WORKLET.toString()})()`], {
          type: "application/javascript",
        });
        const url = URL.createObjectURL(blob);
        await outputAudioContext.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        node.current = new AudioWorkletNode(
          outputAudioContext,
          "buffered-audio-worklet-processor",
        );

        node.current.port.onmessage = (event) => {
          if (event.data.type === "playback_ended") {
            setPlaying(false);
            setIsSpeaking(false);
            worker.current?.postMessage({ type: "playback_ended" });
          }
        };

        const outputAnalyser = outputAudioContext.createAnalyser();
        outputAnalyser.fftSize = 256;

        node.current.connect(outputAnalyser);
        outputAnalyser.connect(outputAudioContext.destination);

        const outputDataArray = new Uint8Array(
          outputAnalyser.frequencyBinCount,
        );

        function updateVisualizers() {
          analyser.getByteTimeDomainData(inputDataArray);
          const rms = calculateRMS(inputDataArray);
          const targetScale = 1 + Math.min(1.25 * rms, 0.25);
          setListeningScale((prev) => prev + (targetScale - prev) * 0.25);

          outputAnalyser.getByteTimeDomainData(outputDataArray);
          const outputRMS = calculateRMS(outputDataArray);
          const targetOutputScale = 1 + Math.min(1.25 * outputRMS, 0.25);
          setSpeakingScale((prev) => prev + (targetOutputScale - prev) * 0.25);

          requestAnimationFrame(updateVisualizers);
        }
        updateVisualizers();
      })
      .catch((err) => {
        setError(err.message);
        console.error(err);
      });

    return () => {
      ignore = true;
      audioStreamPromise.then((s) => s.getTracks().forEach((t) => t.stop()));
      source?.disconnect();
      worklet?.disconnect();
      inputAudioContext?.close();

      outputAudioContext?.close();
    };
  }, [callStarted]);

  useEffect(() => {
    if (!callStarted) return;
    const interval = setInterval(() => {
      const id = Date.now();
      setRipples((prev) => [...prev, id]);
      setTimeout(() => {
        setRipples((prev) => prev.filter((r) => r !== id));
      }, 1500);
    }, 1000);
    return () => clearInterval(interval);
  }, [callStarted]);

  const handleStartCall = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
          sampleRate: INPUT_SAMPLE_RATE,
        },
      });
      micStreamRef.current = stream;

      setCallStartTime(Date.now());
      setCallStarted(true);
      worker.current?.postMessage({ type: "start_call" });
    } catch (err) {
      setError(err.message);
      console.error(err);
    }
  };

  if (!HAS_WEBGPU) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="max-w-md bg-white rounded-xl shadow-lg p-8 text-center space-y-3">
          <h1 className="text-xl font-bold text-gray-800">
            This browser can't run {PERSONA.name}
          </h1>
          <p className="text-gray-600">
            The whole agent (speech recognition, language model and voice) runs
            on your graphics card through WebGPU, and this browser doesn't
            support it.
          </p>
          <p className="text-gray-600">
            It works in Chrome or Edge on desktop, Safari 26 or newer, and
            Firefox on Windows or Apple Silicon.
          </p>
        </div>
      </div>
    );
  }

  const files = Object.values(loadingFiles);
  const bigFiles = files.filter((f) => f.total > 5e6);
  const smallLoaded = files
    .filter((f) => f.total <= 5e6)
    .reduce((acc, f) => acc + f.loaded, 0);
  const totalLoaded = files.reduce((acc, f) => acc + f.loaded, 0);

  return (
    <div className="h-screen min-h-[240px] flex flex-col items-center justify-center bg-gray-50 p-4 relative">
      <div className="w-[640px] max-w-full mb-4 text-center">
        <h1 className="text-2xl font-bold" style={{ color: PERSONA.accent }}>
          {PERSONA.name}
        </h1>
        <p className="text-gray-600">{PERSONA.tagline}</p>
        <p className="text-gray-400 text-sm">
          Runs entirely in your browser. Once loaded, turn off your wifi and
          keep talking. Headphones recommended.
        </p>
      </div>

      <div className="min-h-[320px] w-[640px] max-w-full bg-white rounded-xl shadow-lg p-8 flex items-center justify-between space-x-8">
        {!ready ? (
          <div className="w-full space-y-3">
            <div className="flex justify-between items-baseline">
              <span className="font-semibold text-gray-700">
                Downloading models ({formatMB(totalLoaded)} MB so far)
              </span>
              <span className="text-sm text-gray-400">
                first visit is ~1.7 GB; later visits use the browser cache
              </span>
            </div>
            {bigFiles.map((f) => (
              <div key={`${f.name}/${f.file}`} className="space-y-1">
                <div className="flex justify-between text-sm text-gray-600">
                  <span className="truncate">
                    {f.name.split("/").pop()}
                    {f.file.includes("encoder")
                      ? " (listening)"
                      : f.file.includes("decoder")
                        ? " (understanding)"
                        : ""}
                  </span>
                  <span>
                    {formatMB(f.loaded)} / {f.total ? formatMB(f.total) : "?"}{" "}
                    MB
                  </span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      backgroundColor: PERSONA.accent,
                      width: f.total
                        ? `${Math.min(100, (f.loaded / f.total) * 100)}%`
                        : "0%",
                    }}
                  />
                </div>
              </div>
            ))}
            {smallLoaded > 1e5 && (
              <div className="text-sm text-gray-400">
                + {formatMB(smallLoaded)} MB of tokenizers and configs
              </div>
            )}
            <div className="text-sm text-gray-400">
              Everything downloads once, then runs on your GPU. Nothing you say
              will leave this device.
            </div>
          </div>
        ) : (
          <>
            <div className="w-[140px]" style={{ color: PERSONA.accent }}>
              <div className="text-xl font-bold flex justify-between">
                {voices?.[voice]?.name}
                <span className="font-normal text-gray-500">{elapsedTime}</span>
              </div>
              <div className="text-base relative">
                <button
                  type="button"
                  disabled={!ready}
                  className={`w-full flex items-center justify-between border border-gray-300 rounded-md transition-colors ${
                    ready
                      ? "bg-transparent hover:border-gray-400"
                      : "bg-gray-100 opacity-50 cursor-not-allowed"
                  }`}
                >
                  <span className="px-2 py-1">Select voice</span>
                  <ChevronDown className="absolute right-2" />
                </button>
                <select
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  disabled={!ready}
                >
                  {Object.entries(voices).map(([key, v]) => (
                    <option key={key} value={key}>
                      {`${v.name} (${
                        v.language === "en-us" ? "American" : v.language
                      } ${v.gender})`}
                    </option>
                  ))}
                </select>
              </div>
              {loadSeconds && (
                <div className="text-sm text-gray-400 mt-2">
                  models ready in {loadSeconds} s
                </div>
              )}
            </div>

            <div className="relative flex items-center justify-center w-32 h-32 flex-shrink-0 aspect-square">
              {callStarted &&
                ripples.map((id) => (
                  <div
                    key={id}
                    className="absolute inset-0 rounded-full border-2 pointer-events-none"
                    style={{
                      animation: "ripple 1.5s ease-out forwards",
                      borderColor: `${PERSONA.accent}55`,
                    }}
                  />
                ))}
              <div
                className={`absolute w-32 h-32 rounded-full shadow-inner transition-transform duration-300 ease-out ${
                  error ? "bg-red-300" : ""
                }`}
                style={{
                  transform: `scale(${speakingScale})`,
                  backgroundColor: error ? undefined : `${PERSONA.accent}66`,
                }}
              />
              <div
                className={`absolute w-32 h-32 rounded-full shadow-inner transition-transform duration-300 ease-out ${
                  error ? "bg-red-200" : ""
                }`}
                style={{
                  transform: `scale(${listeningScale})`,
                  backgroundColor: error ? undefined : `${PERSONA.accent}33`,
                }}
              />
              <div
                className={`absolute z-10 text-lg text-center ${
                  error ? "text-red-700" : "text-gray-700"
                }`}
              >
                {error ? (
                  error
                ) : (
                  <>
                    {isListening && "Listening..."}
                    {isSpeaking && "Speaking..."}
                  </>
                )}
              </div>
            </div>

            <div className="space-y-4 w-[140px]">
              {callStarted ? (
                <button
                  className="flex items-center space-x-2 px-4 py-2 bg-red-100 text-red-700 rounded-md hover:bg-red-200"
                  onClick={() => {
                    setCallStarted(false);
                    setCallStartTime(null);
                    setPlaying(false);
                    setIsListening(false);
                    setIsSpeaking(false);
                  }}
                >
                  <PhoneOff className="w-5 h-5" />
                  <span>End call</span>
                </button>
              ) : (
                <button
                  className="flex items-center space-x-2 px-4 py-2 rounded-md bg-blue-100 text-blue-700 hover:bg-blue-200"
                  onClick={handleStartCall}
                >
                  <span>Start call</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {ready && (
        <div className="w-[640px] max-w-full mt-4 grid grid-cols-2 gap-4 text-sm">
          <div className="bg-white rounded-xl shadow p-4">
            <div className="flex items-center space-x-2 font-semibold text-gray-700">
              <ShieldCheck className="w-4 h-4" />
              <span>Network since models loaded</span>
            </div>
            <div className="mt-1 text-2xl font-bold text-gray-800">
              {netRequests === 0
                ? "0 requests"
                : `${netRequests} requests · ${formatMB(netBytes)} MB`}
            </div>
            <div className="text-gray-400">
              Measured with PerformanceObserver on this page. Don't take our
              word for it: turn off your wifi and keep talking.
            </div>
          </div>
          <div className="bg-white rounded-xl shadow p-4">
            <div className="flex items-center space-x-2 font-semibold text-gray-700">
              <Timer className="w-4 h-4" />
              <span>Last reply latency</span>
            </div>
            {timings ? (
              <div className="mt-1 text-gray-800">
                <span className="text-2xl font-bold">
                  {(timings.firstAudio / 1000).toFixed(2)} s
                </span>{" "}
                to first audio
                <div className="text-gray-400">
                  transcription {timings.stt} ms
                  {timings.firstToken != null &&
                    ` · first token ${timings.firstToken} ms`}
                </div>
              </div>
            ) : (
              <div className="mt-1 text-gray-400">
                Start a call to measure it: end of your sentence to the first
                spoken audio.
              </div>
            )}
          </div>
        </div>
      )}

      <div className="absolute bottom-4 text-sm">
        Built with{" "}
        <a
          href="https://github.com/huggingface/transformers.js"
          rel="noopener noreferrer"
          target="_blank"
          className="text-blue-600 hover:underline"
        >
          🤗 Transformers.js
        </a>
      </div>
    </div>
  );
}
