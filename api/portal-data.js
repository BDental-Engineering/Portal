const SM8_KEY = process.env.SERVICEM8_API_KEY;
const SM8_AUTH = 'Basic ' + Buffer.from(SM8_KEY + ':').toString('base64');

async function sm8Get(endpoint) {
  const r = await fetch('https://api.servicem8.com/api_1.0/' + endpoint, {
    headers: {
      Authorization: SM8_AUTH,
      Accept: 'application/json'
    }
  });
  if (!r.ok) {
    console.error('ServiceM8 error:', r.status, await r.text());
    return null;
  }
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Verify session via portal-auth
  const authRes = await fetch('https://' + req.headers.host + '/api/portal-auth', {
    headers: { cookie: req.headers.cookie || '' }
  });

  if (!authRes.ok) return res.status(401).json({ error: 'Not authenticated' });

  // ← these two lines were missing
  const session = await authRes.json();
  const { resource } = req.query;

  const companyUuid = session.customerId;
  const isAdmin = session.role === 'admin';

  if (!companyUuid && !isAdmin) {
    return res.status(400).json({ error: 'No company linked to this account' });
  }

  if (!resource || resource === 'assets') {
    const endpoint = isAdmin
      ? 'asset.json'
      : 'asset.json?%24filter=company_uuid%20eq%20' + companyUuid;

    console.log('Fetching SM8 endpoint:', endpoint);
    const assets = await sm8Get(endpoint);
    console.log('Assets returned:', assets ? assets.length : 'null');

    return res.status(200).json({ assets: assets || [] });
  }

  return res.status(400).json({ error: 'Unknown resource' });
}
