/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost' },
      { protocol: 'http', hostname: '127.0.0.1' },
    ],
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
