/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
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
}

module.exports = nextConfig
