'use client';

import { useState, useRef, useCallback } from 'react';

const FRAME_INTERVAL_MS = 3000;
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

export function useScreenCapture({ onFrame, onAudioChunk }: UseScreenCaptureOptions) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioSegmentTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const shouldRecordAudioRef = useRef(false);

  const stopCapture = useCallback(() => {
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
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    audioRecorderRef.current = null;

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

      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
      });

      intervalRef.current = setInterval(() => {
        if (!videoRef.current) return;
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
              void onAudioChunk(event.data);
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
      displayStream.getVideoTracks()[0].onended = () => stopCapture();
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
