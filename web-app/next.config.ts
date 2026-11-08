import type { NextConfig } from "next";

const basePath = process.env.NODE_ENV === "production" ? "/MachWeb" : "";

const nextConfig: NextConfig = {
  /* config options here */
  //cacheComponents: true,
  //partialPrefetching: true,
  output: 'export',
  basePath,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
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