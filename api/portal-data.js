import crypto from 'crypto';

// ─── ENV ────────────────────────────────────────────────────────────────────
const SM8_KEY   = process.env.SERVICEM8_API_KEY;
const GH_TOKEN  = process.env.GITHUB_TOKEN;
const GH_OWNER  = process.env.GITHUB_OWNER;
const GH_REPO   = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';

// ─── SERVICEM8 ───────────────────────────────────────────────────────────────
async function sm8Get(endpoint) {
  const r = await fetch('https://api.servicem8.com/api_1.0/' + endpoint, {
    headers: { 'X-Api-Key': SM8_KEY, 'Accept': 'application/json' }
  });
  if (!r.ok) {
    console.error('SM8 error:', r.status, await r.text());
    return null;
  }
  return r.json();
}

// ─── GITHUB ──────────────────────────────────────────────────────────────────
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
  return r.ok;
}

// ─── AUTH ────────────────────────────────────────────────────────────────────
function parseCookies(h = '') {
  return Object.fromEntries(
    h.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
}

async function getSession(token) {
  if (!token) return null;
  const { content } = await ghGet('data/portal_sessions.json');
  return (content || []).find(
    s => s.token === token && new Date(s.expiresAt) > new Date()
  ) || null;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const token = parseCookies(req.headers.cookie || '')['portal_session'];
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { resource } = req.query;
  const isAdmin = session.role === 'admin';
  const companyUuid = session.customerId;

  // ── ASSETS (ServiceM8) ──────────────────────────────────────────────────
  if (!resource || resource === 'assets') {
    const assetEndpoint = isAdmin
      ? 'asset.json'
      : 'asset.json?%24filter=company_uuid%20eq%20' + companyUuid;

    const [assets, assetTypes] = await Promise.all([
      sm8Get(assetEndpoint),
      sm8Get('assettype.json')
    ]);

    if (!assets) return res.status(500).json({ error: 'Failed to load assets' });

    const typeMap = {};
    if (assetTypes) assetTypes.forEach(t => { typeMap[t.uuid] = t.name; });

    const enriched = assets.map(a => {
      const fieldArray = Array.isArray(a.field_data) ? a.field_data : [];
      const byName = {};
      fieldArray.forEach(f => { byName[f.fieldName] = f.fieldValue; });

      return {
        uuid: a.uuid,
        name: a.name || 'Unnamed Asset',
        active: a.active,
        company_uuid: a.company_uuid,
        asset_type_name: typeMap[a.asset_type_uuid] || null,
        make: byName['Make'] || null,
        model: byName['Model'] || null,
        serial: byName['Serial Number'] || null,
        location: byName['Location'] || null,
        service_due: byName['Service Due'] || null,
        warranty_end: byName['Warranty End Date'] || null,
        compliance: byName['Compliance'] || null,
        fields: fieldArray
          .slice()
          .sort((x, y) => (x.sortOrder || 0) - (y.sortOrder || 0))
          .map(f => ({ name: f.fieldName, value: f.fieldValue }))
      };
    });

    return res.status(200).json({ assets: enriched });
  }

  // ── CUSTOMERS (ServiceM8) ───────────────────────────────────────────────
  if (resource === 'customers') {
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    const companies = await sm8Get('company.json?%24filter=active%20eq%201');
    if (!companies) return res.status(500).json({ error: 'Failed to load customers' });

    const customers = companies.map(c => ({
      id: c.uuid,
      name: c.name,
      email: c.email || '',
      phone: c.phone || '',
      address: c.address ||
        [c.address_street, c.address_city, c.address_state, c.address_postcode]
          .filter(Boolean).join(', '),
      active: c.active === 1
    }));

    return res.status(200).json(customers);
  }

  // ── MANUALS (ServiceM8 Knowledge Articles) ──────────────────────────────
  if (resource === 'manuals') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const articles = await sm8Get('knowledgearticle.json?%24filter=active%20eq%201');
    if (!articles) return res.status(500).json({ error: 'Failed to load manuals' });

    const { make, model, tag } = req.query;

    let manuals = articles.map(a => {
      // Parse tags into array
      const tags = a.tags
        ? a.tags.split(',').map(t => t.trim()).filter(Boolean)
        : [];

      return {
        id: a.uuid,
        title: a.name,
        content: a.content || null,
        article_type: a.article_type || 'richtext',
        tags,
        active: a.active
      };
    });

    // Filter by make tag if provided
    if (make) {
      manuals = manuals.filter(m =>
        m.tags.some(t => t.toLowerCase() === make.toLowerCase())
      );
    }

    // Filter by model tag if provided
    if (model) {
      manuals = manuals.filter(m =>
        m.tags.some(t => t.toLowerCase() === model.toLowerCase())
      );
    }

    // Filter by any arbitrary tag if provided
    if (tag) {
      manuals = manuals.filter(m =>
        m.tags.some(t => t.toLowerCase() === tag.toLowerCase())
      );
    }

    return res.status(200).json(manuals);
  }

  // ── DOCUMENTS (GitHub) ──────────────────────────────────────────────────
  if (resource === 'documents') {
    const { content, sha } = await ghGet('data/portal_documents.json');
    let docs = content || [];

    if (req.method === 'GET') {
      if (!isAdmin) docs = docs.filter(d => d.customerId === companyUuid && d.active);
      return res.status(200).json(docs);
    }

    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    if (req.method === 'POST') {
      const { customerId, assetId, title, type, fileUrl, active } = req.body;
      if (!title || !customerId || !fileUrl)
        return res.status(400).json({ error: 'title, customerId and fileUrl required' });
      const rec = {
        id: crypto.randomUUID(),
        customerId,
        assetId: assetId || null,
        title,
        type: type || 'Other',
        fileUrl,
        uploadedAt: new Date().toISOString(),
        active: active !== false
      };
      docs.push(rec);
      await ghPut('data/portal_documents.json', docs, sha);
      return res.status(201).json(rec);
    }

    if (req.method === 'PUT') {
      const { id, ...fields } = req.body;
      const idx = docs.findIndex(d => d.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      docs[idx] = { ...docs[idx], ...fields };
      await ghPut('data/portal_documents.json', docs, sha);
      return res.status(200).json(docs[idx]);
    }

    if (req.method === 'DELETE') {
      const { id } = req.body;
      const idx = docs.findIndex(d => d.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      docs.splice(idx, 1);
      await ghPut('data/portal_documents.json', docs, sha);
      return res.status(200).json({ success: true });
    }
  }

  return res.status(400).json({ error: 'Unknown resource' });
}
