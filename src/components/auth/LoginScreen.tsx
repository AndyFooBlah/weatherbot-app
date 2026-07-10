// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0

import { useState } from 'react';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  AuthError,
} from 'firebase/auth';
import { auth } from '@andyfooblah/voice-common';

type Mode = 'sign-in' | 'sign-up';

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      if (mode === 'sign-in') {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        // The functions' allow-list check requires a verified email — an
        // unverified account can sign in but can't reach any weather data.
        try {
          await sendEmailVerification(credential.user);
          setNotice(
            'Account created. Check your inbox for a verification link — ' +
              'access is enabled once your email is verified.',
          );
        } catch {
          setNotice(
            'Account created, but the verification email failed to send. ' +
              'Try signing in again later to resend it.',
          );
        }
      }
    } catch (err) {
      setError((err as AuthError).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogleSignIn() {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      const code = (err as AuthError).code;
      if (code === 'auth/operation-not-allowed') {
        setError(
          'Google sign-in is not enabled yet for this project. Enable it in the Firebase Console → Authentication → Sign-in method.',
        );
      } else {
        setError((err as AuthError).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm p-8">
        <h1 className="text-2xl font-semibold mb-1">WeatherBot</h1>
        <p className="text-sm text-slate-500 mb-6">
          Personal weather data, on your phone.
        </p>

        <button
          onClick={handleGoogleSignIn}
          disabled={submitting}
          className="w-full px-4 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-medium transition mb-4 disabled:opacity-50"
        >
          Continue with Google
        </button>

        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-xs uppercase tracking-wide text-slate-400">or</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>

        <form onSubmit={handleEmailSubmit} className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoComplete="email"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 focus:border-sky-500 focus:outline-none text-sm"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
            minLength={6}
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 focus:border-sky-500 focus:outline-none text-sm"
          />
          <button
            type="submit"
            disabled={submitting}
            className="w-full px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-600 text-white text-sm font-medium transition disabled:opacity-50"
          >
            {submitting ? '…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          onClick={() => {
            setMode((m) => (m === 'sign-in' ? 'sign-up' : 'sign-in'));
            setError(null);
          }}
          className="w-full mt-4 text-xs text-slate-500 hover:text-slate-700"
        >
          {mode === 'sign-in'
            ? "Don't have an account? Create one"
            : 'Already have an account? Sign in'}
        </button>

        {error && (
          <div className="mt-4 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-700">
            {error}
          </div>
        )}

        {notice && (
          <div className="mt-4 px-3 py-2 rounded-lg bg-sky-50 border border-sky-200 text-sm text-sky-700">
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}
