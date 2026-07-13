import type { NextConfig } from "next"
import path from "node:path"

const nextConfig: NextConfig = {
  // Pin Turbopack's workspace root to the repo root so Next stops inferring an
  // unrelated ancestor (e.g. ~/pnpm-lock.yaml) as the root. The repo root is the
  // real workspaces root (holds package-lock.json) and keeps ../shared inside the
  // root boundary so the shared contract import still resolves.
  turbopack: {
    root: path.join(__dirname, ".."),
  },
  // The API routes import backend (A) + outreach (D) source TS from sibling
  // workstream dirs; allow compiling TS from outside the Next app root.
  experimental: {
    externalDir: true,
  },
}

export default nextConfig
