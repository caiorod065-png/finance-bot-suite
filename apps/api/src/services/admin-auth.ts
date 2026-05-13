import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

type AdminUserRow = {
  id: string;
  email: string;
  password_hash: string;
  role: string;
};

export type AdminSession = {
  id: string;
  email: string;
  role: string;
  authType: 'jwt' | 'legacy-token';
};

type JwtPayload = {
  sub: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
};

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function toBase64Url(input: Buffer | string): string {
  const encoded = Buffer.isBuffer(input)
    ? input.toString('base64')
    : Buffer.from(input, 'utf8').toString('base64');
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): Buffer {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  return Buffer.from(`${base64}${padding}`, 'base64');
}

function parseHash(hash: string): {
  n: number;
  r: number;
  p: number;
  saltHex: string;
  digestHex: string;
} | null {
  const parts = hash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const digestHex = parts[5];

  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(digestHex)) return null;

  return { n, r, p, saltHex, digestHex };
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const parsed = parseHash(storedHash);
  if (!parsed) {
    // fallback para instalações antigas em desenvolvimento
    return storedHash === password;
  }

  const salt = Buffer.from(parsed.saltHex, 'hex');
  const expected = Buffer.from(parsed.digestHex, 'hex');
  const derived = scryptSync(password, salt, expected.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: 64 * 1024 * 1024
  });

  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (config.adminJwtExpiresMinutes * 60);
  const fullPayload: JwtPayload = { ...payload, iat, exp };

  const headerB64 = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = toBase64Url(JSON.stringify(fullPayload));
  const data = `${headerB64}.${payloadB64}`;
  const signature = createHmac('sha256', config.adminJwtSecret).update(data).digest();
  return `${data}.${toBase64Url(signature)}`;
}

function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const data = `${headerB64}.${payloadB64}`;

  const expectedSignature = createHmac('sha256', config.adminJwtSecret).update(data).digest();
  let givenSignature: Buffer;
  try {
    givenSignature = fromBase64Url(signatureB64);
  } catch {
    return null;
  }

  if (expectedSignature.length !== givenSignature.length) return null;
  if (!timingSafeEqual(expectedSignature, givenSignature)) return null;

  try {
    const payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8')) as JwtPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.sub || !payload.email || !payload.role) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseBearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null;
  const [scheme, token] = authHeader.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

export async function ensureAdminBootstrapUser(): Promise<void> {
  const email = config.adminEmail;
  const existing = await pool.query<AdminUserRow>(
    `SELECT id, email, password_hash, role
     FROM admin_users
     WHERE email = $1
     LIMIT 1`,
    [email]
  );

  if (!config.adminPassword) {
    return;
  }

  const hashed = hashPassword(config.adminPassword);

  if (!existing.rowCount || !existing.rows[0]) {
    await pool.query(
      `INSERT INTO admin_users (email, password_hash, role)
       VALUES ($1, $2, 'owner')`,
      [email, hashed]
    );
    return;
  }

  const current = existing.rows[0].password_hash;
  if (!parseHash(current)) {
    await pool.query(
      `UPDATE admin_users
       SET password_hash = $2
       WHERE id = $1`,
      [existing.rows[0].id, hashed]
    );
  }
}

export async function authenticateAdmin(email: string, password: string): Promise<AdminSession | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await pool.query<AdminUserRow>(
    `SELECT id, email, password_hash, role
     FROM admin_users
     WHERE email = $1
     LIMIT 1`,
    [normalizedEmail]
  );

  const row = user.rows[0];
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;

  // Migra hash legado (texto puro) para scrypt após login bem sucedido.
  if (!parseHash(row.password_hash)) {
    const upgraded = hashPassword(password);
    await pool.query(
      `UPDATE admin_users
       SET password_hash = $2
       WHERE id = $1`,
      [row.id, upgraded]
    );
  }

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    authType: 'jwt'
  };
}

export async function setAdminPassword(email: string, password: string, role = 'owner'): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const hashed = hashPassword(password);

  await pool.query(
    `INSERT INTO admin_users (email, password_hash, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (email)
     DO UPDATE SET password_hash = EXCLUDED.password_hash,
                   role = EXCLUDED.role`,
    [normalizedEmail, hashed, role]
  );
}

export function issueAdminToken(session: Pick<AdminSession, 'id' | 'email' | 'role'>): {
  token: string;
  expiresInSeconds: number;
} {
  const token = signJwt({
    sub: session.id,
    email: session.email,
    role: session.role
  });

  return {
    token,
    expiresInSeconds: config.adminJwtExpiresMinutes * 60
  };
}

export function getAdminSessionFromRequest(headers: Record<string, unknown>): AdminSession | null {
  const bearer = parseBearerToken(headers.authorization);
  if (bearer) {
    const payload = verifyJwt(bearer);
    if (payload) {
      return {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        authType: 'jwt'
      };
    }
  }

  // Compatibilidade com o token legado (n8n/scripts existentes).
  const legacyToken = headers['x-admin-token'];
  if (typeof legacyToken === 'string' && legacyToken === config.adminToken) {
    return {
      id: 'legacy-admin-token',
      email: 'legacy-token@local',
      role: 'owner',
      authType: 'legacy-token'
    };
  }

  return null;
}
