// db.js — Firestore helpers
'use strict';
const admin = require('firebase-admin');

let _db;

function initDB() {
  const creds = process.env.FIREBASE_CREDENTIALS;
  if (!creds) throw new Error('FIREBASE_CREDENTIALS not set');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(creds)) });
  _db = admin.firestore();
  console.log('[db] Firestore initialized');
  return _db;
}

// Полная запись / merge на уровне документа
async function saveUser(userId, data) {
  await _db.collection('users').doc(String(userId)).set(data, { merge: true });
}

// Частичное обновление вложенных полей через dot-notation
// Пример: updateUser(id, { 'away.active': false })
async function updateUser(userId, dotUpdates) {
  await _db.collection('users').doc(String(userId)).update(dotUpdates);
}

async function getUser(userId) {
  const doc = await _db.collection('users').doc(String(userId)).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function getTemplates(userId) {
  const snap = await _db.collection('users').doc(String(userId))
    .collection('templates').orderBy('createdAt').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function saveTemplate(userId, templateId, data) {
  await _db.collection('users').doc(String(userId))
    .collection('templates').doc(templateId).set(data, { merge: true });
}

async function deleteTemplate(userId, templateId) {
  await _db.collection('users').doc(String(userId))
    .collection('templates').doc(templateId).delete();
}

async function getAllConnectedUsers() {
  const snap = await _db.collection('users').where('connected', '==', true).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

module.exports = {
  initDB,
  saveUser,
  updateUser,
  getUser,
  getTemplates,
  saveTemplate,
  deleteTemplate,
  getAllConnectedUsers
};
