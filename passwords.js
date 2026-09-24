const crypto = require('crypto');

/* Admin-managed passwords are kept encrypted (AES-256-GCM) so the admin page can show them.
   The key comes from SESSION_SECRET: changing SESSION_SECRET makes stored passwords unreadable
   (the admin page then says to reset them). Logins still use the bcrypt hash. */

const key = () => crypto.createHash('sha256').update('admin-managed-password:' + process.env.SESSION_SECRET).digest();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

/* Returns the password, or null if there is none or it cannot be read. */
function decrypt(stored) {
  if (!stored) return null;
  try {
    const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

module.exports = { encrypt, decrypt };
