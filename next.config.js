/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow loading from local network IP when accessing from another device
  allowedDevOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://192.168.101.252:3000', 'http://192.168.101.254:3000'],
  // Disable dev indicators to reduce segment-explorer / manifest race conditions (see .cursor/NEXT_CACHE_INVESTIGATION.md)
  devIndicators: false,
  // Enable experimental features for better performance
  experimental: {
    optimizePackageImports: ['recharts', 'date-fns', 'lucide-react'],
    // Enable partial prerendering for faster initial loads
    ppr: false, // Can enable if needed
  },
  // Compiler optimizations
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? {
      exclude: ['error', 'warn'],
    } : false,
  },
  // Optimize images if you add them later
  images: {
    formats: ['image/avif', 'image/webp'],
    unoptimized: true, // Disable image optimization for faster builds
  },
  // Performance optimizations
  // swcMinify is enabled by default in Next.js 15, no need to specify
  // Enable compression
  compress: true,
  // Add output configuration for better performance
  // Only use standalone in production builds, not in dev mode
  ...(process.env.NODE_ENV === 'production' ? { output: 'standalone' } : {}), // Reduces bundle size
  // Optimize bundle splitting (only in production - dev full rebuilds can corrupt .next cache)
  webpack: (config, { isServer, dev }) => {
    if (!isServer && !dev) {
      config.optimization = {
        ...config.optimization,
        splitChunks: {
          chunks: 'all',
          cacheGroups: {
            default: false,
            vendors: false,
            // Vendor chunk for large libraries
            vendor: {
              name: 'vendor',
              chunks: 'all',
              test: /node_modules/,
              priority: 20,
            },
            // Common chunk for shared code
            common: {
              name: 'common',
              minChunks: 2,
              chunks: 'all',
              priority: 10,
              reuseExistingChunk: true,
              enforce: true,
            },
          },
        },
      };
    }
    return config;
  },
}

module.exports = nextConfig





