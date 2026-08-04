/** @type {import('next').NextConfig} */

// Backend origin the site proxies to. Defaults to the Railway backend but
// can be overridden with the BACKEND_ORIGIN env var (e.g. to point at a
// staging API). NO trailing slash.
const BACKEND_ORIGIN = (
  process.env.BACKEND_ORIGIN ?? 'https://abhinandanproduct-production.up.railway.app'
).replace(/\/$/, '');

const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost' },
      { protocol: 'http', hostname: '127.0.0.1' },
    ],
  },
  // Same-origin API proxy. The browser calls /api/* and /uploads/* on THIS
  // site's own domain (which resolves on every network), and Vercel forwards
  // them to the backend server-side — so no client ever has to resolve the
  // Railway domain (some ISP/WiFi DNS resolvers fail on *.up.railway.app),
  // and there is no cross-origin/CORS step at all. Set the frontend to use
  // these relative paths via NEXT_PUBLIC_API_URL=/api and an empty
  // NEXT_PUBLIC_FILE_BASE. Only matters in deployment; local dev keeps
  // hitting the backend directly via .env.local.
  async rewrites() {
    return [
      { source: '/api/:path*',     destination: `${BACKEND_ORIGIN}/api/:path*` },
      { source: '/uploads/:path*', destination: `${BACKEND_ORIGIN}/uploads/:path*` },
    ];
  },
  // Preserve browser scroll position across back/forward navigations.
  // The App Router already restores scroll on browser back, but the
  // extra flag ensures forward → back → forward reliably rewinds too,
  // and prevents mid-scroll refetches (TanStack Query background
  // refetches) from being interpreted as a fresh navigation.
  experimental: {
    scrollRestoration: true,
  },
};

export default nextConfig;
