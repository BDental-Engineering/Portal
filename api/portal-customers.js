import crypto from 'crypto';

const GH_TOKEN  = process.env.GITHUB_TOKEN;
const GH_OWNER  = process.env.GITHUB_OWNER;
const GH_REPO   = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE       = 'data/portal_customers.json';

async function ghGet(path) {
  const r = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`,
    { headers: { Authorization: `token \${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
  );
  if (r.status === 404) return { content: null, sha: null };
  const d = await r.json();
  return { content: JSON.parse(Buffer.from(d.content, 'base64').toString('utf8')), sha: d.sha };
}

async function ghPut(path, data, sha) {
  const body = { message: `update \${path}`, content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'), branch: GH_BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`,
    { method: 'PUT', headers: { Authorization: `token \${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return r.ok;
}

async function getSession(token) {
  if (!token) return null;
  const { content } = await ghGet('data/portal_sessions.json');
  return (content || []).find(s => s.token === token && new Date(s.expiresAt) > new Date()) || null;
}

function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

export default async function handler(req, res) {
  const token = parseCookies(req.headers.cookie || '')['portal_session'];
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { content, sha } = await ghGet(FILE);
  const customers = content || [];

  if (req.method === 'GET') {
    return res.status(200).json(customers);
  }

  if (req.method === 'POST') {
    const { name, email, phone, address, active } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const rec = { id: crypto.randomUUID(), name, email: email || '', phone: phone || '', address: address || '', active: active !== false, createdAt: new Date().toISOString() };
    customers.push(rec);
    await ghPut(FILE, customers, sha);
    return res.status(201).json(rec);
  }

  if (req.method === 'PUT') {
    const { id, ...fields } = req.body;
    const idx = customers.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    customers[idx] = { ...customers[idx], ...fields };
    await ghPut(FILE, customers, sha);
    return res.status(200).json(customers[idx]);
  }

  if (req.method === 'DELETE') {
    const { id } = req.body;
    const idx = customers.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    customers.splice(idx, 1);
    await ghPut(FILE, customers, sha);
    return res.status(200).json({ success: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
