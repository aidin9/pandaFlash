// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',   // replaces `next export`
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  trailingSlash: true,
  skipTrailingSlashRedirect: true,
  distDir: "out",
  images: {
    unoptimized: true,
  },
  basePath: "/pandaFlash",
  assetPrefix: "/pandaFlash/",
  experimental: {
    esmExternals: "loose",
  },
};

export default nextConfig;
