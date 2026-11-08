import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  //cacheComponents: true,
  //partialPrefetching: true,
  output: 'export',
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  allowedDevOrigins: ['192.168.1.89'],
  images: {
    unoptimized: true, // Disable image optimization for static export
  },
  experimental: {
    ppr: false,
  },
};

export default nextConfig;