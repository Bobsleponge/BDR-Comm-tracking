/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
  // Optimize bundle splitting
  webpack: (config, { isServer }) => {
    if (!isServer) {
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





