// Copy this file to firebase-config.js and fill in your own Firebase web config and site key.
// Firebase web config for the Red Pen project. These values are public identifiers,
// not secrets: access is protected by App Check (Fraud Defense / reCAPTCHA Enterprise) on the Firebase side.
export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.firebasestorage.app',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
};

// Fraud Defense (reCAPTCHA Enterprise) site key used by App Check (public by design).
export const recaptchaSiteKey = 'REPLACE_ME';
