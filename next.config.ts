import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker 映像只帶 .next/standalone（ADR-0011）
  output: "standalone",
  // 允許同資料夾跑第二個 dev server（各自的 dist dir，避免 .next/dev lock 衝突）
  distDir: process.env.NEXT_DIST_DIR || undefined,
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
