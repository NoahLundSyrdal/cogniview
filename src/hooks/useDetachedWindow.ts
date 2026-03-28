'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseDetachedWindowOptions {
  title: string;
  name: string;
  features: string;
  pictureInPicture?: {
    width: number;
    height: number;
  };
}

type WindowMode = 'pip' | 'popup';

interface DocumentPictureInPictureController {
  window: Window | null;
  requestWindow: (options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
    preferInitialWindowPlacement?: boolean;
  }) => Promise<Window>;
}

type WindowWithDocumentPictureInPicture = Window & {
  documentPictureInPicture?: DocumentPictureInPictureController;
};

function copyStyles(source: Document, target: Document) {
  target.head.innerHTML = '';

  for (const node of source.querySelectorAll('link[rel="stylesheet"], style')) {
    target.head.appendChild(node.cloneNode(true));
  }
}

export function useDetachedWindow({
  title,
  name,
  features,
  pictureInPicture,
}: UseDetachedWindowOptions) {
  const popupRef = useRef<Window | null>(null);
  const closeHandlerRef = useRef<(() => void) | null>(null);
  const closeEventRef = useRef<'beforeunload' | 'pagehide' | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<WindowMode | null>(null);

  const clearPopupState = useCallback(() => {
    const popup = popupRef.current;

    if (popup && closeHandlerRef.current && closeEventRef.current) {
      popup.removeEventListener(closeEventRef.current, closeHandlerRef.current);
    }

    closeHandlerRef.current = null;
    closeEventRef.current = null;
    popupRef.current = null;
    setMode(null);
    setPortalContainer(null);
  }, []);

  const syncPopupDocument = useCallback(
    (popup: Window) => {
      popup.document.title = title;
      popup.document.documentElement.lang = document.documentElement.lang || 'en';
      popup.document.documentElement.className = document.documentElement.className;
      popup.document.body.className = document.body.className;
      popup.document.body.style.margin = '0';
      popup.document.body.style.minHeight = '100vh';
      popup.document.body.style.background = '#030712';
      copyStyles(document, popup.document);
    },
    [title]
  );

  const focusWindow = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus();
    }
  }, []);

  const closeWindow = useCallback(() => {
    const popup = popupRef.current;

    clearPopupState();

    if (popup && !popup.closed) {
      popup.close();
    }
  }, [clearPopupState]);

  const openWindow = useCallback(async () => {
    const existingPopup = popupRef.current;

    if (existingPopup && !existingPopup.closed) {
      existingPopup.focus();
      return true;
    }

    let popup: Window | null = null;
    let nextMode: WindowMode = 'popup';
    let closeEvent: 'beforeunload' | 'pagehide' = 'beforeunload';
    const windowWithPiP = window as WindowWithDocumentPictureInPicture;

    if (windowWithPiP.documentPictureInPicture && pictureInPicture) {
      try {
        popup = await windowWithPiP.documentPictureInPicture.requestWindow({
          width: pictureInPicture.width,
          height: pictureInPicture.height,
          preferInitialWindowPlacement: true,
        });
        nextMode = 'pip';
        closeEvent = 'pagehide';
      } catch (error) {
        console.warn('Floating sidebar Picture-in-Picture failed, falling back to popup.', error);
      }
    }

    if (!popup) {
      popup = window.open('', name, features);
      nextMode = 'popup';
      closeEvent = 'beforeunload';
    }

    if (!popup) {
      return false;
    }

    syncPopupDocument(popup);
    popup.document.body.innerHTML = '';

    const container = popup.document.createElement('div');
    container.style.height = '100vh';
    popup.document.body.appendChild(container);

    const handleClose = () => {
      clearPopupState();
    };

    popup.addEventListener(closeEvent, handleClose);
    closeHandlerRef.current = handleClose;
    closeEventRef.current = closeEvent;
    popupRef.current = popup;
    setMode(nextMode);
    setPortalContainer(container);
    popup.focus();
    return true;
  }, [clearPopupState, features, name, pictureInPicture, syncPopupDocument]);

  useEffect(() => {
    return () => {
      closeWindow();
    };
  }, [closeWindow]);

  return {
    isOpen: Boolean(portalContainer),
    mode,
    portalContainer,
    openWindow,
    focusWindow,
    closeWindow,
  };
}
