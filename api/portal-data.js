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

    const [assets, assetTypes] = await Promise.all([
      sm8Get(assetEndpoint),
      sm8Get('assettype.json')
    ]);

    if (!assets) return res.status(500).json({ error: 'Failed to load assets' });

    // Build type name lookup
    const typeMap = {};
    if (assetTypes) {
      assetTypes.forEach(t => { typeMap[t.uuid] = t.name; });
    }

    // Enrich each asset — field_data is an array with fieldName/fieldValue
    const enriched = assets.map(a => {
      const typeName = typeMap[a.asset_type_uuid] || null;
      const fieldArray = Array.isArray(a.field_data) ? a.field_data : [];
      console.log('First asset field_data:', JSON.stringify(a.field_data));

      // Build a name->value map for easy lookup
      const byName = {};
      fieldArray.forEach(f => {
        byName[f.fieldName] = f.fieldValue;
      });

      return {
        uuid: a.uuid,
        name: a.name || 'Unnamed Asset',
        active: a.active,
        asset_type_name: typeName,
        make: byName['Make'] || null,
        model: byName['Model'] || null,
        serial: byName['Serial Number'] || null,
        location: byName['Location'] || null,
        service_due: byName['Service Due'] || null,
        // All fields for full display, sorted by sortOrder
        fields: fieldArray
          .slice()
          .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
          .map(f => ({ name: f.fieldName, value: f.fieldValue }))
      };
    });

    console.log('Assets returned:', enriched.length);
    return res.status(200).json({ assets: enriched });
  }

  return res.status(400).json({ error: 'Unknown resource' });
}
