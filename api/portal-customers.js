const SM8_KEY = process.env.SERVICEM8_API_KEY;

async function sm8Get(endpoint) {
  const r = await fetch('https://api.servicem8.com/api_1.0/' + endpoint, {
    headers: {
      'X-Api-Key': SM8_KEY,
      'Accept': 'application/json'
    }
  });
  if (!r.ok) {
    console.error('ServiceM8 error:', r.status, await r.text());
    return null;
  }
  return r.json();
}

function parseCookies(h = '') {
  return Object.fromEntries(
    h.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
}

async function getSession(token) {
  if (!token) return null;
  // Re-use your existing session check from portal-auth
  const { content } = await ghGet('data/portal_sessions.json').catch(() => ({ content: null }));
  return (content || []).find(s => s.token === token && new Date(s.expiresAt) > new Date()) || null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = parseCookies(req.headers.cookie || '')['portal_session'];

  // Validate session via portal-auth
  const authRes = await fetch('https://' + req.headers.host + '/api/portal-auth', {
    headers: { cookie: req.headers.cookie || '' }
  });
  if (!authRes.ok) return res.status(401).json({ error: 'Not authenticated' });

  const session = await authRes.json();
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const companies = await sm8Get('company.json?%24filter=active%20eq%201');
  if (!companies) return res.status(500).json({ error: 'Failed to load customers' });

  // Map SM8 company fields to your portal customer format
  const customers = companies.map(c => ({
    id: c.uuid,
    name: c.name,
    email: c.email || '',
    phone: c.phone || '',
    address: c.address || [c.address_street, c.address_city, c.address_state, c.address_postcode].filter(Boolean).join(', '),
    active: c.active === 1
  }));

  return res.status(200).json(customers);
}
