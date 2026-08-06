import crypto from 'crypto';

const SM8_KEY   = process.env.SERVICEM8_API_KEY;
const GH_TOKEN  = process.env.GITHUB_TOKEN;
const GH_OWNER  = process.env.GITHUB_OWNER;
const GH_REPO   = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';

// ── SERVICEM8 ────────────────────────────────────────────────────────────────
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

// ── GITHUB ───────────────────────────────────────────────────────────────────
async function ghGet(path) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`;
  const r = await fetch(url, {
    headers: {
      Authorization: 'token ' + GH_TOKEN,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'portal-data'
    }
  });
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) {
    console.error('GitHub ghGet error:', r.status, await r.text());
    return { content: null, sha: null };
  }
  const text = await r.text();
  try {
    const d = JSON.parse(text);
    if (!d.content) return { content: null, sha: null };
    return {
      content: JSON.parse(Buffer.from(d.content, 'base64').toString('utf8')),
      sha: d.sha
    };
  } catch(e) {
    console.error('GitHub parse error:', e.message, text.slice(0, 200));
    return { content: null, sha: null };
  }
}

async function ghPut(path, data, sha) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;
  const body = {
    message: 'update ' + path,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: 'token ' + GH_TOKEN,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'portal-data'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) console.error('ghPut error:', r.status, await r.text());
  return r.ok;
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
async function getSession(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const url   = `${proto}://${host}/api/portal-auth`;

  console.log('getSession: calling', url, 'cookie:', req.headers.cookie ? 'present' : 'missing');

  const r = await fetch(url, {
    method: 'GET',
    headers: {
      cookie: req.headers.cookie || '',
      Accept: 'application/json'
    }
  });

  console.log('getSession: portal-auth responded', r.status);

  if (!r.ok) return null;
  return r.json();
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { resource } = req.query;
  const isAdmin     = session.role === 'admin';
  const companyUuid = session.customerId;

  console.log('portal-data: resource=' + resource + ' role=' + session.role);

  // ── ASSETS ────────────────────────────────────────────────────────────────
  if (!resource || resource === 'assets') {
    const endpoint = isAdmin
      ? 'asset.json'
      : 'asset.json?%24filter=company_uuid%20eq%20' + companyUuid;

    const [assets, assetTypes] = await Promise.all([
      sm8Get(endpoint),
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

  // ── CUSTOMERS ─────────────────────────────────────────────────────────────
  if (resource === 'customers') {
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    const companies = await sm8Get('company.json?%24filter=active%20eq%201');
    if (!companies) return res.status(500).json({ error: 'Failed to load customers' });

    return res.status(200).json(companies.map(c => ({
      id: c.uuid,
      name: c.name,
      email: c.email || '',
      phone: c.phone || '',
      address: c.address ||
        [c.address_street, c.address_city, c.address_state, c.address_postcode]
          .filter(Boolean).join(', '),
      active: c.active === 1
    })));
  }

  // ── MANUALS ───────────────────────────────────────────────────────────────
  if (resource === 'manuals') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const articles = await sm8Get('knowledgearticle.json?%24filter=active%20eq%201');
    if (!articles) return res.status(500).json({ error: 'Failed to load manuals' });

    const { make, model, tag } = req.query;
    let manuals = articles.map(a => ({
      id: a.uuid,
      title: a.name,
      content: a.content || null,
      article_type: a.article_type || 'richtext',
      tags: a.tags ? a.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      active: a.active
    }));

    if (make)  manuals = manuals.filter(m => m.tags.some(t => t.toLowerCase() === make.toLowerCase()));
    if (model) manuals = manuals.filter(m => m.tags.some(t => t.toLowerCase() === model.toLowerCase()));
    if (tag)   manuals = manuals.filter(m => m.tags.some(t => t.toLowerCase() === tag.toLowerCase()));

    return res.status(200).json(manuals);
  }

  // ── DOCUMENTS ─────────────────────────────────────────────────────────────
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
        id: crypto.randomUUID(), customerId,
        assetId: assetId || null, title,
        type: type || 'Other', fileUrl,
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

  // ── ATTACHMENTS / SITE DIARY ───────────────────────────────────────────────
  if (resource === 'attachments') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { companyId } = req.query;

    // non-admins can only see their own company
    const targetCompanyId = isAdmin
      ? (companyId || null)
      : companyUuid;

    if (!targetCompanyId) return res.status(400).json({ error: 'companyId required' });

    // fetch in parallel:
    // 1. attachments directly on the company record
    // 2. all jobs for this company (so we can get their UUIDs)
    const [companyAttachments, jobs] = await Promise.all([
      sm8Get('attachment.json?%24filter=related_object_uuid%20eq%20' + targetCompanyId),
      sm8Get('job.json?%24filter=company_uuid%20eq%20' + targetCompanyId)
    ]);

    const results = [];

    // ── company-level attachments
    if (companyAttachments) {
      companyAttachments
        .filter(a => a.active === 1)
        .forEach(a => {
          results.push(normaliseAttachment(a, 'company', null));
        });
    }

    // ── job-level attachments — fetch all in parallel (capped to avoid timeout)
    if (jobs && jobs.length) {
      // only fetch jobs that are active and limit to 50 most recent to avoid timeout
      const activeJobs = jobs
        .filter(j => j.active === 1)
        .sort((a, b) => new Date(b.edit_date || 0) - new Date(a.edit_date || 0))
        .slice(0, 50);

      const jobAttachmentArrays = await Promise.all(
        activeJobs.map(j =>
          sm8Get('attachment.json?%24filter=related_object_uuid%20eq%20' + j.uuid)
            .then(atts => ({ job: j, atts: atts || [] }))
            .catch(() => ({ job: j, atts: [] }))
        )
      );

      jobAttachmentArrays.forEach(({ job, atts }) => {
        atts
          .filter(a => a.active === 1)
          .forEach(a => {
            results.push(normaliseAttachment(a, 'job', job));
          });
      });
    }

    // sort all results newest first
    results.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    return res.status(200).json(results);
  }

  return res.status(400).json({ error: 'Unknown resource' });
}

// ── NORMALISE ATTACHMENT ──────────────────────────────────────────────────────
function normaliseAttachment(a, sourceType, job) {
  // build a readable URL — ServiceM8 attachment files are served from their CDN
  const fileUrl = a.uuid
    ? 'https://api.servicem8.com/api_1.0/attachment/' + a.uuid + '/file'
    : null;

  // determine a display type from attachment_source or file_type
  let type = 'File';
  const src = (a.attachment_source || '').toUpperCase();
  const ext = (a.file_type || '').toLowerCase();
  if (src === 'INVOICE')         type = 'Invoice';
  else if (src === 'QUOTE')      type = 'Quote';
  else if (src === 'WORKORDER')  type = 'Work Order';
  else if (src === 'FORM')       type = 'Form';
  else if (src === 'REPORT')     type = 'Report';
  else if (['.jpg','.jpeg','.png','.gif','.webp'].includes(ext)) type = 'Photo';
  else if (ext === '.pdf')       type = 'PDF';

  return {
    uuid:          a.uuid,
    name:          a.attachment_name || 'Untitled',
    type:          type,
    source:        sourceType,           // 'company' or 'job'
    file_type:     a.file_type || '',
    file_url:      fileUrl,
    tags:          a.tags || '',
    is_favourite:  a.is_favourite === 1,
    date:          a.timestamp || a.edit_date || null,
    created_by:    a.created_by_staff_uuid || null,
    // job context (null for company-level attachments)
    job_uuid:      job ? job.uuid       : null,
    job_number:    job ? job.generated_job_id : null,
    job_status:    job ? job.status     : null,
    job_desc:      job ? (job.job_description || job.name || '') : null,
    // extra info extracted from the file if available
    extracted_info: a.extracted_info || null,
    metadata:       a.metadata || null
  };
}
