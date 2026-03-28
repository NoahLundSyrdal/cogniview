'use client';

import { useState, useRef, useCallback } from 'react';

const FRAME_INTERVAL_MS = 3000;
const FRAME_FINGERPRINT_WIDTH = 32;
const FRAME_FINGERPRINT_HEIGHT = 18;
const FRAME_CHANGE_RATIO_THRESHOLD = 0.03;
const FRAME_CHANGE_BUCKET_DELTA = 2;
const AUDIO_TIMESLICE_MS = 5000;
const MIN_AUDIO_CHUNK_BYTES = 2048;
const AUDIO_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

interface UseScreenCaptureOptions {
  onFrame: (frame: string) => void;
  onAudioChunk?: (audio: Blob) => void | Promise<void>;
}

function getSupportedAudioMimeType() {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return AUDIO_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function createFrameFingerprint(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D
) {
  canvas.width = FRAME_FINGERPRINT_WIDTH;
  canvas.height = FRAME_FINGERPRINT_HEIGHT;
  context.drawImage(video, 0, 0, FRAME_FINGERPRINT_WIDTH, FRAME_FINGERPRINT_HEIGHT);

  const imageData = context.getImageData(0, 0, FRAME_FINGERPRINT_WIDTH, FRAME_FINGERPRINT_HEIGHT).data;
  const fingerprint = new Uint8Array(FRAME_FINGERPRINT_WIDTH * FRAME_FINGERPRINT_HEIGHT);

  for (let sourceIndex = 0, targetIndex = 0; sourceIndex < imageData.length; sourceIndex += 4, targetIndex += 1) {
    const red = imageData[sourceIndex];
    const green = imageData[sourceIndex + 1];
    const blue = imageData[sourceIndex + 2];
    const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
    fingerprint[targetIndex] = Math.round(luminance / 17);
  }

  return fingerprint;
}

function hasMeaningfulFrameChange(previous: Uint8Array | null, next: Uint8Array) {
  if (!previous || previous.length !== next.length) {
    return true;
  }

  let changedBuckets = 0;
  for (let index = 0; index < next.length; index += 1) {
    if (Math.abs(previous[index] - next[index]) >= FRAME_CHANGE_BUCKET_DELTA) {
      changedBuckets += 1;
    }
  }

  return changedBuckets / next.length >= FRAME_CHANGE_RATIO_THRESHOLD;
}

export function useScreenCapture({ onFrame, onAudioChunk }: UseScreenCaptureOptions) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fingerprintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fingerprintContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const lastFrameFingerprintRef = useRef<Uint8Array | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioSegmentTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const shouldRecordAudioRef = useRef(false);
  const pendingAudioChunkJobsRef = useRef<Set<Promise<void>>>(new Set());

  const stopCapture = useCallback(async () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (audioSegmentTimeoutRef.current) {
      clearTimeout(audioSegmentTimeoutRef.current);
      audioSegmentTimeoutRef.current = null;
    }

    shouldRecordAudioRef.current = false;

    const recorder = audioRecorderRef.current;
    let recorderStopPromise: Promise<void> | null = null;
    if (recorder && recorder.state !== 'inactive') {
      recorderStopPromise = new Promise((resolve) => {
        recorder.addEventListener(
          'stop',
          () => {
            resolve();
          },
          { once: true }
        );
      });
      recorder.stop();
    }

    if (recorderStopPromise) {
      await recorderStopPromise;
    }

    audioRecorderRef.current = null;

    const pendingAudioChunkJobs = [...pendingAudioChunkJobsRef.current];
    if (pendingAudioChunkJobs.length > 0) {
      await Promise.allSettled(pendingAudioChunkJobs);
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => null);
      audioContextRef.current = null;
    }

    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach((track) => track.stop());
      displayStreamRef.current = null;
    }

    if (microphoneStreamRef.current) {
      microphoneStreamRef.current.getTracks().forEach((track) => track.stop());
      microphoneStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }
    fingerprintCanvasRef.current = null;
    fingerprintContextRef.current = null;
    lastFrameFingerprintRef.current = null;

    setIsCapturing(false);
  }, []);

  const startCapture = useCallback(async () => {
    setCaptureError(null);

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: true,
      });
      displayStreamRef.current = displayStream;

      let microphoneStream: MediaStream | null = null;
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        microphoneStreamRef.current = microphoneStream;
      } catch (error) {
        console.warn('Microphone capture unavailable, continuing with display audio only.', error);
      }

      const video = document.createElement('video');
      video.srcObject = displayStream;
      video.playsInline = true;
      void video.play();
      videoRef.current = video;
      const fingerprintCanvas = document.createElement('canvas');
      const fingerprintContext = fingerprintCanvas.getContext('2d');
      if (!fingerprintContext) {
        throw new Error('Canvas 2D context is unavailable for screen capture.');
      }
      fingerprintCanvasRef.current = fingerprintCanvas;
      fingerprintContextRef.current = fingerprintContext;
      lastFrameFingerprintRef.current = null;

      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
      });

      intervalRef.current = setInterval(() => {
        if (!videoRef.current || !fingerprintCanvasRef.current || !fingerprintContextRef.current) return;
        if (videoRef.current.videoWidth === 0 || videoRef.current.videoHeight === 0) return;

        const fingerprint = createFrameFingerprint(
          videoRef.current,
          fingerprintCanvasRef.current,
          fingerprintContextRef.current
        );
        if (!hasMeaningfulFrameChange(lastFrameFingerprintRef.current, fingerprint)) {
          return;
        }

        lastFrameFingerprintRef.current = fingerprint;
        const canvas = document.createElement('canvas');
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        canvas.getContext('2d')?.drawImage(videoRef.current, 0, 0);
        const frame = canvas.toDataURL('image/jpeg', 0.7);
        onFrame(frame);
      }, FRAME_INTERVAL_MS);

      const audioStreams = [displayStream, microphoneStream].filter(
        (stream): stream is MediaStream => Boolean(stream?.getAudioTracks().length)
      );

      if (audioStreams.length > 0 && onAudioChunk) {
        const audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();

        for (const stream of audioStreams) {
          const source = audioContext.createMediaStreamSource(
            new MediaStream(stream.getAudioTracks())
          );
          source.connect(destination);
        }

        const mimeType = getSupportedAudioMimeType();
        void audioContext.resume().catch(() => null);
        audioContextRef.current = audioContext;
        shouldRecordAudioRef.current = true;

        const startAudioSegment = () => {
          if (!shouldRecordAudioRef.current) return;

          const recorder = mimeType
            ? new MediaRecorder(destination.stream, { mimeType })
            : new MediaRecorder(destination.stream);

          recorder.ondataavailable = (event) => {
            if (event.data.size >= MIN_AUDIO_CHUNK_BYTES) {
              const pendingJob = Promise.resolve(onAudioChunk(event.data))
                .catch(() => undefined)
                .finally(() => {
                  pendingAudioChunkJobsRef.current.delete(pendingJob);
                });
              pendingAudioChunkJobsRef.current.add(pendingJob);
            }
          };

          recorder.onstop = () => {
            if (!shouldRecordAudioRef.current) return;
            startAudioSegment();
          };

          recorder.start();
          audioRecorderRef.current = recorder;
          audioSegmentTimeoutRef.current = setTimeout(() => {
            if (recorder.state === 'recording') {
              recorder.stop();
            }
          }, AUDIO_TIMESLICE_MS);
        };

        startAudioSegment();
      }

      setIsCapturing(true);
      displayStream.getVideoTracks()[0].onended = () => {
        void stopCapture();
      };
      return true;
    } catch (err) {
      const error = err as DOMException;
      if (error.name === 'NotAllowedError') {
        setCaptureError(
          'Screen share, system audio, or microphone access was cancelled or denied. Click Start Capture to try again.'
        );
      } else if (error.name === 'NotFoundError') {
        setCaptureError('No screen or audio source was available to capture.');
      } else {
        setCaptureError(error.message || 'Screen capture failed.');
      }
      return false;
    }
  }, [onAudioChunk, onFrame, stopCapture]);

  return { isCapturing, captureError, startCapture, stopCapture };
}
