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

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authRes = await fetch('https://' + req.headers.host + '/api/portal-auth', {
    headers: { cookie: req.headers.cookie || '' }
  });

  if (!authRes.ok) return res.status(401).json({ error: 'Not authenticated' });

  const session = await authRes.json();
  const { resource } = req.query;

  const companyUuid = session.customerId;
  const isAdmin = session.role === 'admin';

  if (!companyUuid && !isAdmin) {
    return res.status(400).json({ error: 'No company linked to this account' });
  }

  if (!resource || resource === 'assets') {
    const assetEndpoint = isAdmin
      ? 'asset.json'
      : 'asset.json?%24filter=company_uuid%20eq%20' + companyUuid;

    // Fetch all three in parallel
    const [assets, assetTypes, assetTypeFields] = await Promise.all([
      sm8Get(assetEndpoint),
      sm8Get('assettype.json'),
      sm8Get('assettypefield.json')
    ]);

    if (!assets) return res.status(500).json({ error: 'Failed to load assets' });

    // Build lookup maps
    const typeMap = {};
    if (assetTypes) {
      assetTypes.forEach(t => {
        typeMap[t.uuid] = t.name;
      });
    }

    // Build field map: asset_type_uuid -> array of field definitions
    const fieldMap = {};
    if (assetTypeFields) {
      assetTypeFields.forEach(f => {
        if (!fieldMap[f.asset_type_uuid]) fieldMap[f.asset_type_uuid] = [];
        fieldMap[f.asset_type_uuid].push(f);
      });
      // Sort each type's fields by sort_order
      Object.keys(fieldMap).forEach(k => {
        fieldMap[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      });
    }

    // Enrich each asset
const enriched = assets.map(a => {
  const typeName = typeMap[a.asset_type_uuid] || null;
  const fields = fieldMap[a.asset_type_uuid] || [];

  // field_data can be an object or array depending on SM8 response
  const rawFieldData = a.field_data || {};
  let fieldData = {};

  if (Array.isArray(rawFieldData)) {
    // Array format: [{ field_uuid: '...', value: '...' }]
    rawFieldData.forEach(f => {
      fieldData[f.field_uuid] = f.value;
    });
  } else {
    // Object format: { 'uuid': 'value' }
    fieldData = rawFieldData;
  }

  let make = null, model = null, serial = null;
  fields.forEach(f => {
    const val = fieldData[f.uuid] || null;
    const name = (f.name || '').trim();
    if (name === 'Make') make = val;
    if (name === 'Model') model = val;
    if (name === 'Serial Number') serial = val;
  });

  return {
    uuid: a.uuid,
    name: a.name || 'Unnamed Asset',
    active: a.active,
    asset_type_name: typeName,
    make,
    model,
    serial,
    fields: fields.map(f => ({
      name: f.name,
      value: fieldData[f.uuid] || null
    }))
  };
});

