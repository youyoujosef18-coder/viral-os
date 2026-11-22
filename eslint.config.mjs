import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Images here are either authenticated API streams (/api/v1/media/*) or third-party platform
      // thumbnails (ytimg, tiktokcdn, cdninstagram). next/image can't forward the session cookie and
      // would proxy third-party CDNs through our server, so plain <img loading="lazy"> is intentional.
      "@next/next/no-img-element": "off",
    },
  },
  {
    files: ["scripts/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-expressions": ["warn", { allowTernary: true }] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    ".storage/**",
    ".storage-test/**",
  ]),
]);

export default eslintConfig;
