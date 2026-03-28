'use client';

import { useState, useRef, useCallback } from 'react';

export function useScreenCapture(onFrame: (frame: string) => void) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startCapture = useCallback(async () => {
    setCaptureError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: false,
      });

      streamRef.current = stream;

      const video = document.createElement('video');
      video.srcObject = stream;
      video.play();
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
      }, 3000);

      setIsCapturing(true);
      stream.getVideoTracks()[0].onended = () => stopCapture();
    } catch (err) {
      const error = err as DOMException;
      if (error.name === 'NotAllowedError') {
        setCaptureError('Screen share was cancelled or denied. Click Start Capture to try again.');
      } else if (error.name === 'NotFoundError') {
        setCaptureError('No screen available to capture.');
      } else {
        setCaptureError(error.message || 'Screen capture failed.');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFrame]);

  const stopCapture = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }
    setIsCapturing(false);
  }, []);

  return { isCapturing, captureError, startCapture, stopCapture };
}
