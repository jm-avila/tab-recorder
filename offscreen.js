// Offscreen document: mixes tab audio + mic, records with the tab video, hands a blob URL back.
import { pickMimeType, rmsToVu } from './lib.js';

let session = null;

// Live level of a source for the popup's needle meters, in VU.
function levelMeter(audio, source) {
  const analyser = audio.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return () => {
    analyser.getFloatTimeDomainData(samples);
    return rmsToVu(Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length));
  };
}

const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg });

async function getMic() {
  // An offscreen document can't show a prompt: asking without a grant would hang.
  const { state } = await navigator.permissions.query({ name: 'microphone' });
  if (state !== 'granted') return null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    return null; // Mic not granted: record the tab only.
  }
}

async function start(streamId, filename) {
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const tab = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: source },
    video: { mandatory: { ...source, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
  });
  const mic = await getMic();

  const audio = new AudioContext();
  const mix = audio.createMediaStreamDestination();
  const tabAudio = audio.createMediaStreamSource(tab);
  tabAudio.connect(audio.destination); // Capturing mutes the tab; keep playing it to the user.
  tabAudio.connect(mix);
  const micAudio = mic && audio.createMediaStreamSource(mic);
  micAudio?.connect(mix);
  const levels = { tab: levelMeter(audio, tabAudio), mic: micAudio ? levelMeter(audio, micAudio) : () => -Infinity };

  const stream = new MediaStream([...tab.getVideoTracks(), ...mix.stream.getAudioTracks()]);
  const recorder = new MediaRecorder(stream, {
    mimeType: pickMimeType((t) => MediaRecorder.isTypeSupported(t)),
    videoBitsPerSecond: 1_500_000,
    audioBitsPerSecond: 128_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    [...tab.getTracks(), ...(mic?.getTracks() ?? [])].forEach((t) => t.stop());
    audio.close();
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    toBackground({ type: 'save', url: URL.createObjectURL(blob), filename });
    session = null;
  };

  tab.getVideoTracks()[0].addEventListener('ended', () => {
    if (recorder.state === 'recording') {
      toBackground({ type: 'ended' });
      recorder.stop();
    }
  });

  recorder.start(1000);
  session = { recorder, levels };
  toBackground({ type: 'started', mic: Boolean(mic) });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'levels') {
    // JSON turns -Infinity into null; the popup reads null as silence.
    sendResponse(session ? { tab: session.levels.tab(), mic: session.levels.mic() } : null);
    return;
  }
  if (msg.type === 'start') {
    start(msg.streamId, msg.filename).catch((err) => toBackground({ type: 'error', message: String(err?.message ?? err) }));
  }
  if (msg.type === 'stop' && session?.recorder.state === 'recording') session.recorder.stop();
});
