import crypto from 'crypto';

const GH_TOKEN  = process.env.GITHUB_TOKEN;
const GH_OWNER  = process.env.GITHUB_OWNER;
const GH_REPO   = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE       = 'data/portal_manuals.json';

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

  const { content, sha } = await ghGet(FILE);
  let manuals = content || [];

  if (req.method === 'GET') {
    const { make, model } = req.query;
    // Auto-match: filter by make+model (case-insensitive) if provided
    if (make && model) {
      manuals = manuals.filter(m =>
        m.make.toLowerCase() === make.toLowerCase() &&
        m.model.toLowerCase() === model.toLowerCase() &&
        m.active
      );
    }
    return res.status(200).json(manuals);
  }

  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  if (req.method === 'POST') {
    const { make, model, title, fileUrl, description, active } = req.body;
    if (!make || !model || !title || !fileUrl) return res.status(400).json({ error: 'make, model, title and fileUrl required' });
    const rec = { id: crypto.randomUUID(), make, model, title, fileUrl, description: description || '', active: active !== false, createdAt: new Date().toISOString() };
    manuals.push(rec);
    await ghPut(FILE, manuals, sha);
    return res.status(201).json(rec);
  }

  if (req.method === 'PUT') {
    const { id, ...fields } = req.body;
    const idx = manuals.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    manuals[idx] = { ...manuals[idx], ...fields };
    await ghPut(FILE, manuals, sha);
    return res.status(200).json(manuals[idx]);
  }

  if (req.method === 'DELETE') {
    const { id } = req.body;
    const idx = manuals.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    manuals.splice(idx, 1);
    await ghPut(FILE, manuals, sha);
    return res.status(200).json({ success: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
