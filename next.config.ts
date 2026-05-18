import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow dev resources to be requested from IPv4 hosts on the local network.
  allowedDevOrigins: ["*.*.*.*", "giving-foxhound-top.ngrok-free.app"],
  // Hide the Next.js Dev Tools floating indicator in development.
  devIndicators: false,
};

export default nextConfig;
