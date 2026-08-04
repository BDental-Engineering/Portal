export default async function handler(req, res) {
  const token  = process.env.GITHUB_TOKEN  || '';
  const owner  = process.env.GITHUB_OWNER  || '';
  const repo   = process.env.GITHUB_REPO   || '';
  const branch = process.env.GITHUB_BRANCH || '';

  // Test the token against GitHub API
  let githubTest = null;
  let githubUser = null;
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token \${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'portal-debug'
      }
    });
    const d = await r.json();
    githubTest = r.status;
    githubUser = d.login || d.message || null;
  } catch (e) {
    githubTest = 'fetch_error';
    githubUser = e.message;
  }

  // Test repo access
  let repoTest = null;
  let repoMsg  = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `token \${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'portal-debug'
      }
    });
    const d = await r.json();
    repoTest = r.status;
    repoMsg  = d.full_name || d.message || null;
  } catch (e) {
    repoTest = 'fetch_error';
    repoMsg  = e.message;
  }

  res.status(200).json({
    env: {
      GITHUB_TOKEN:  token  ? `SET — length \${token.length}, starts with "${token.slice(0,6)}…"` : 'NOT SET',
      GITHUB_OWNER:  owner  || 'NOT SET',
      GITHUB_REPO:   repo   || 'NOT SET',
      GITHUB_BRANCH: branch || 'NOT SET',
    },
    githubTokenTest: {
      status:        githubTest,
      authenticatedAs: githubUser,
      verdict: githubTest === 200 ? '✅ Token is valid' : '❌ Token is invalid or expired'
    },
    repoAccessTest: {
      status:  repoTest,
      repo:    repoMsg,
      verdict: repoTest === 200 ? '✅ Repo found' : repoTest === 404 ? '❌ Repo not found — check GITHUB_OWNER and GITHUB_REPO' : '❌ Access denied'
    }
  });
}
