/** @type {import('next').NextConfig} */

// Server-side targets for the proxy below. These are read in the Node process,
// never in the browser, so they can be in-network container names and can be
// changed without rebuilding the client bundle.
const POOL_MONITOR = process.env.POOL_MONITOR_URL || 'http://pool-monitor:8080';
const HARNESS = process.env.HARNESS_URL || 'http://trueforge-harness:3000';

export default {
  reactStrictMode: true,
  output: 'standalone',

  /**
   * The browser talks only to this origin; Next proxies onward server-side.
   *
   * Previously the client called pool-monitor and the harness directly on their
   * own ports, which is cross-origin and so depends on CORS headers, on the
   * backend ports being published to whatever host the browser resolves, and on
   * the build-time URLs matching how the page was actually opened. Opening the
   * UI on a LAN/WSL address broke all three at once, and the browser reports
   * the result as "Missing Allow Origin" no matter which one failed.
   *
   * Same-origin requests cannot fail that way: there is no preflight, and no
   * backend port needs to be reachable from the browser at all.
   */
  async rewrites() {
    return [
      { source: '/api/pool/:path*', destination: `${POOL_MONITOR}/api/v1/:path*` },
      { source: '/api/harness/:path*', destination: `${HARNESS}/api/v1/:path*` },
    ];
  },
};
