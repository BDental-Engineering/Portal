import crypto from 'crypto';

const GH_TOKEN  = process.env.GITHUB_TOKEN;
const GH_OWNER  = process.env.GITHUB_OWNER;
const GH_REPO   = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const SESSION_HOURS = 8;

// ── GitHub helpers ─────────────────────────────────────
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

// ── Helpers ────────────────────────────────────────────
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function uid()     { return crypto.randomUUID(); }
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}
function setCookieHeader(token, maxAge) {
  return `portal_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}`;
}

// ── Session helpers ────────────────────────────────────
async function getSession(token) {
  if (!token) return null;
  const { content } = await ghGet('data/portal_sessions.json');
  const sessions = content || [];
  const s = sessions.find(x => x.token === token && new Date(x.expiresAt) > new Date());
  return s || null;
}

async function purgeSessions() {
  const { content, sha } = await ghGet('data/portal_sessions.json');
  const sessions = (content || []).filter(s => new Date(s.expiresAt) > new Date());
  await ghPut('data/portal_sessions.json', sessions, sha);
  return sessions;
}

// ── Handler ────────────────────────────────────────────
export default async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token   = cookies['portal_session'];

  // GET — session check
  if (req.method === 'GET') {
    const s = await getSession(token);
    if (!s) return res.status(401).json({ error: 'Not authenticated' });
    // Fetch user name
    const { content: users } = await ghGet('data/portal_users.json');
    const user = (users || []).find(u => u.id === s.userId);
    return res.status(200).json({ ok: true, userId: s.userId, role: s.role, customerId: s.customerId, name: user?.name || '' });
  }

  if (req.method === 'POST') {
    const { action } = req.body;

    // LOGIN
    if (action === 'login') {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const { content: users } = await ghGet('data/portal_users.json');
      const user = (users || []).find(u => u.email.toLowerCase() === email.toLowerCase() && u.active);
      if (!user || user.passwordHash !== sha256(password)) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Create session
      const sessionToken = uid();
      const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
      const { content: sessions, sha } = await ghGet('data/portal_sessions.json');
      const updated = [...(sessions || []).filter(s => new Date(s.expiresAt) > new Date()), { token: sessionToken, userId: user.id, role: user.role, customerId: user.customerId, expiresAt }];
      await ghPut('data/portal_sessions.json', updated, sha);

      res.setHeader('Set-Cookie', setCookieHeader(sessionToken, SESSION_HOURS * 3600));
      return res.status(200).json({ success: true, role: user.role, name: user.name });
    }

    // LOGOUT
    if (action === 'logout') {
      if (token) {
        const { content: sessions, sha } = await ghGet('data/portal_sessions.json');
        const updated = (sessions || []).filter(s => s.token !== token);
        await ghPut('data/portal_sessions.json', updated, sha);
      }
      res.setHeader('Set-Cookie', setCookieHeader('', 0));
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
