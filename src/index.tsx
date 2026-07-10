// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Application entry point. Initializes VoiceCommon (which owns Firebase
// init + the Gemini Live token provider) and mounts the React app.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { initializeVoiceCommon } from '@andyfooblah/voice-common';
import { App } from './App';
import { mintGeminiLiveToken } from './services/geminiBroker';
import './index.css';

initializeVoiceCommon({
  firebase: {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  },
  // VoiceCommon's useSession calls tokenProvider() to obtain a single-use
  // ephemeral Gemini Live token from our server broker — the long-lived
  // GEMINI_API_KEY never reaches the browser.
  tokenProvider: mintGeminiLiveToken,
});

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
