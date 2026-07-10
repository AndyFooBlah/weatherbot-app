// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// requireAllowed — defense-in-depth allow-list check for callable functions.
//
// The Firebase Auth Console settings are belt; this is suspenders. Even if
// the Console is misconfigured, a Google account holder who slips into
// the project still can't reach the weather data unless their email is in
// the Firestore `allowed_emails/{lowercased-email}` collection.

import { HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore } from 'firebase-admin/firestore';

const ALLOW_LIST_COLLECTION = 'allowed_emails';

export interface AllowedCaller {
  /** Firebase Auth uid. */
  uid: string;
  /** Lowercased email — matches the allow-list document ID. */
  email: string;
}

/**
 * Verifies (a) the caller is signed in, (b) their session carries an email,
 * and (c) that email is present in the Firestore allow-list. Returns
 * { uid, email } on success so callers can use them without re-narrowing
 * the auth context. Throws HttpsError on any failure.
 */
export async function requireAllowed(
  request: CallableRequest<unknown>,
): Promise<AllowedCaller> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign-in required.');
  }
  const email = request.auth.token.email?.toLowerCase();
  if (!email) {
    logger.warn('[requireAllowed] auth.token.email missing', {
      uid: request.auth.uid,
    });
    throw new HttpsError(
      'permission-denied',
      'No verified email on session.',
    );
  }
  // The allow-list keys off the email claim, but anyone can create an
  // email/password account claiming an arbitrary address — without this
  // check, an attacker who knows an allow-listed email that has no Firebase
  // account yet could register it themselves and pass the list.
  if (request.auth.token.email_verified !== true) {
    logger.warn('[requireAllowed] email not verified', { email });
    throw new HttpsError(
      'permission-denied',
      'Verify your email address first — check your inbox for the verification link.',
    );
  }
  const db = getFirestore();
  const doc = await db.collection(ALLOW_LIST_COLLECTION).doc(email).get();
  if (!doc.exists) {
    logger.info('[requireAllowed] not allow-listed', { email });
    throw new HttpsError(
      'permission-denied',
      'Access not authorized for this account.',
    );
  }
  return { uid: request.auth.uid, email };
}
