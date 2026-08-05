import crypto from 'crypto';

const GH_TOKEN  = process.env.GITHUB_TOKEN;
const GH_OWNER  = process.env.GITHUB_OWNER;
const GH_REPO   = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE       = 'data/portal_users.json';

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

async function ghGet(path) {
  const r = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`,
    { headers: { Authorization: `token \${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
  );
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) {
    console.error('GitHub error:', r.status, await r.text());
    return { content: null, sha: null };
  }
  const d = await r.json();
  if (!d.content) return { content: null, sha: null };
  return { content: JSON.parse(Buffer.from(d.content, 'base64').toString('utf8')), sha: d.sha };
}

async function ghPut(path, data, sha) {
  const body = {
    message: `update \${path}`,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;
  const r = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token \${GH_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
  if (!r.ok) console.error('ghPut error:', r.status, await r.text());
  return r.ok;
}

async function getSession(token) {
  if (!token) return null;
  const { content } = await ghGet('data/portal_sessions.json');
  return (content || []).find(s => s.token === token && new Date(s.expiresAt) > new Date()) || null;
}

function parseCookies(h = '') {
  return Object.fromEntries(
    h.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
}

function safeUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}

export default async function handler(req, res) {
  const token = parseCookies(req.headers.cookie || '')['portal_session'];
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { content, sha } = await ghGet(FILE);
  let users = content || [];

  if (req.method === 'GET') {
    return res.status(200).json(users.map(safeUser));
  }

  if (req.method === 'POST') {
    const { name, email, password, role, customerId, active } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'name, email and password required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
      return res.status(409).json({ error: 'Email already exists' });
    const rec = {
      id: crypto.randomUUID(),
      name, email,
      passwordHash: sha256(password),
      role: role || 'customer',
      customerId: customerId || null,
      active: active !== false,
      createdAt: new Date().toISOString()
    };
    users.push(rec);
    await ghPut(FILE, users, sha);
    return res.status(201).json(safeUser(rec));
  }

  if (req.method === 'PUT') {
    const { id, password, ...fields } = req.body;
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    if (password) {
      if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      fields.passwordHash = sha256(password);
    }
    users[idx] = { ...users[idx], ...fields };
    await ghPut(FILE, users, sha);
    return res.status(200).json(safeUser(users[idx]));
  }

  res.status(405).json({ error: 'Method not allowed' });
}
