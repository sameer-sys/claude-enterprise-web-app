import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function parseSemver(v: string): number[] {
  const clean = v.replace(/^v/i, '').trim();
  const parts = clean.split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function isNewerVersion(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lNum = l[i] || 0;
    const cNum = c[i] || 0;
    if (lNum > cNum) return true;
    if (lNum < cNum) return false;
  }
  return false;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const clientVersion = searchParams.get('current') || searchParams.get('version') || '1.0.52';
    const repo = 'sameer-sys/claude-enterprise-desktop-app';
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Claude-Enterprise-Desktop-App',
      },
      next: { revalidate: 60 },
    });

    if (!response.ok) {
      return NextResponse.json({
        hasUpdate: false,
        latestVersion: clientVersion,
        currentVersion: clientVersion,
        downloadUrl: `https://github.com/${repo}/releases`,
        releaseNotes: 'Up to date.',
      });
    }

    const release = await response.json();
    const exeAsset = Array.isArray(release.assets)
      ? release.assets.find((a: any) => String(a.name).endsWith('.exe'))
      : null;

    const latestVersion = release.tag_name || release.name || clientVersion;
    const downloadUrl = exeAsset?.browser_download_url || release.html_url || `https://github.com/${repo}/releases`;

    const hasUpdate = isNewerVersion(latestVersion, clientVersion);

    return NextResponse.json({
      hasUpdate,
      latestVersion,
      currentVersion: clientVersion,
      downloadUrl,
      releaseNotes: release.body || 'New features, bug fixes, and performance improvements.',
      publishedAt: release.published_at,
    });
  } catch (error: any) {
    return NextResponse.json({
      hasUpdate: false,
      error: error?.message || 'Failed to check for updates',
    }, { status: 500 });
  }
}
