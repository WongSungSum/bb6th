import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 不暴露框架版本
  poweredByHeader: false,
  // 基本安全标头（CSP 等部署方式确定后再加）
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
