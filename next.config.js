/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  basePath: '/pandaFlash',
  assetPrefix: '/pandaFlash/',
}

module.exports = nextConfig
