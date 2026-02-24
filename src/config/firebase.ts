import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { env } from "./env.js";

let initialized = false;

function initFirebase() {
  if (initialized) return;

  const serviceAccount: ServiceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);

  initializeApp({
    credential: cert(serviceAccount),
    storageBucket: env.FIREBASE_STORAGE_BUCKET,
  });

  // Required for Bun compatibility — avoids gRPC issues
  const db = getFirestore();
  db.settings({ preferRest: true });

  initialized = true;
}

export function getDb() {
  initFirebase();
  return getFirestore();
}

export function getBucket() {
  initFirebase();
  return getStorage().bucket();
}
