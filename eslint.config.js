import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "node_modules/**",
      ".superpowers/**",
      ".local/**",
      ".wrangler/**",
      // Local session-tool state; it is not project source.
      ".remember/**",
    ],
  },
  ...tseslint.configs.recommended,
);
