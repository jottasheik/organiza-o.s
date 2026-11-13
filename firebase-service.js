const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const USERS_FILE = path.join(ROOT_DIR, 'users.json');

let firebaseInitialized = false;
let db = null;
let auth = null;

function initFirebaseAdmin() {
  if (firebaseInitialized) return { db, auth, initialized: true };

  try {
    let credential = null;
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(ROOT_DIR, 'serviceAccountKey.json');

    if (fs.existsSync(serviceAccountPath)) {
      const sa = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      credential = admin.credential.cert(sa);
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      });
    }

    if (credential) {
      if (!admin.apps.length) {
        admin.initializeApp({
          credential,
          projectId: process.env.FIREBASE_PROJECT_ID
        });
      }
      db = admin.firestore();
      auth = admin.auth();
      firebaseInitialized = true;
      console.log('✔ Firebase Admin SDK inicializado com sucesso (Firestore e Auth conectados)');
    } else {
      console.log('ℹ Firebase Admin: credenciais de serviço não encontradas. Operando com armazenamento local seguro (users.json).');
    }
  } catch (err) {
    console.warn('⚠ Erro ao inicializar Firebase Admin SDK (usando armazenamento local):', err.message);
  }

  return { db, auth, initialized: firebaseInitialized };
}

// Armazenamento local seguro (fallback quando Firestore não estiver conectado)
function readLocalUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Erro ao ler users.json:', e.message);
  }
  return {};
}

function writeLocalUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (e) {
    console.error('Erro ao gravar users.json:', e.message);
  }
}

// Salva ou atualiza os dados do cliente no Firestore e no arquivo local
async function saveUser(userData) {
  const uid = userData.googleId || userData.email.replace(/[^a-zA-Z0-9]/g, '_');
  const now = new Date().toISOString();

  // 1. Salva localmente
  const localUsers = readLocalUsers();
  const existing = localUsers[uid] || {};
  const updatedUser = {
    ...existing,
    ...userData,
    uid,
    updatedAt: now,
    createdAt: existing.createdAt || now
  };
  localUsers[uid] = updatedUser;
  writeLocalUsers(localUsers);

  // 2. Salva no Firestore se o Firebase Admin estiver configurado
  if (firebaseInitialized && db) {
    try {
      await db.collection('users').doc(uid).set(updatedUser, { merge: true });
    } catch (e) {
      console.warn('Erro ao salvar no Firestore (mantido localmente):', e.message);
    }
  }

  return updatedUser;
}

// Busca usuário por UID ou e-mail
async function getUser(uidOrEmail) {
  if (!uidOrEmail) return null;

  // Busca no local
  const localUsers = readLocalUsers();
  for (const key of Object.keys(localUsers)) {
    const u = localUsers[key];
    if (u.uid === uidOrEmail || u.email === uidOrEmail || u.googleId === uidOrEmail) {
      return u;
    }
  }

  // Busca no Firestore
  if (firebaseInitialized && db) {
    try {
      const doc = await db.collection('users').doc(uidOrEmail).get();
      if (doc.exists) return doc.data();

      const snap = await db.collection('users').where('email', '==', uidOrEmail).limit(1).get();
      if (!snap.empty) return snap.docs[0].data();
    } catch (e) {
      console.warn('Erro ao consultar Firestore:', e.message);
    }
  }

  return null;
}

// Gera Custom Token do Firebase para o cliente autenticar no frontend
async function createCustomToken(uid) {
  if (firebaseInitialized && auth) {
    try {
      return await auth.createCustomToken(uid);
    } catch (e) {
      console.warn('Não foi possível gerar custom token Firebase:', e.message);
    }
  }
  return null;
}

// Salva os dados de negócio (outreach, leads, meetings) no Firestore
async function saveUserData(uid, data) {
  if (firebaseInitialized && db && uid) {
    try {
      await db.collection('users').doc(uid).collection('app_data').doc('current').set({
        savedAt: new Date().toISOString(),
        outreach: data.outreach || [],
        leads: data.leads || [],
        meetings: data.meetings || []
      }, { merge: true });
    } catch (e) {
      console.warn('Erro ao salvar dados no Firestore:', e.message);
    }
  }
}

// Carrega os dados de negócio do Firestore
async function getUserData(uid) {
  if (firebaseInitialized && db && uid) {
    try {
      const doc = await db.collection('users').doc(uid).collection('app_data').doc('current').get();
      if (doc.exists) return doc.data();
    } catch (e) {
      console.warn('Erro ao buscar dados do Firestore:', e.message);
    }
  }
  return null;
}

module.exports = {
  initFirebaseAdmin,
  saveUser,
  getUser,
  createCustomToken,
  saveUserData,
  getUserData,
  isFirebaseActive: () => firebaseInitialized
};
