// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0

import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { auth } from '@andyfooblah/voice-common';
import { LoginScreen } from './components/auth/LoginScreen';
import { SessionView } from './components/session/SessionView';

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return unsub;
  }, []);

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-slate-500">Loading…</div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  return <SessionView user={user} />;
}
