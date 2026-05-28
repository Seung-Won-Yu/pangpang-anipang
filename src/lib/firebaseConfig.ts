export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const firebaseEnabledFlag = import.meta.env.VITE_FIREBASE_ENABLED;
const firebaseFunctionsFlag = import.meta.env.VITE_FIREBASE_USE_FUNCTIONS;

export const isFirebaseConfigured = Boolean(
  firebaseEnabledFlag !== "false" &&
  firebaseConfig.apiKey &&
  firebaseConfig.projectId &&
  firebaseConfig.appId,
);

export const useFirebaseFunctions = firebaseFunctionsFlag === "true";
