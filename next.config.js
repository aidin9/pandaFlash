/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',         // enables static HTML export
  images: {
    unoptimized: true,      // disables Next.js server image optimization
  },
  basePath: '/pandaFlash',  // 👈 repo name
  assetPrefix: '/pandaFlash/',
}

module.exports = nextConfig
