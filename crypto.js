// crypto.js — AES-256-CBC шифрование сессий пользователей
'use strict';
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY || '';
  if (hex.length !== 64) throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  return Buffer.from(hex, 'hex');
}

function encrypt(text) {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
}

function decrypt(data) {
  const key = getKey();
  const colonIdx = data.indexOf(':');
  const iv = Buffer.from(data.slice(0, colonIdx), 'hex');
  const enc = data.slice(colonIdx + 1);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let dec = decipher.update(enc, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

module.exports = { encrypt, decrypt };
