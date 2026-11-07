import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this checkout's tests. Claude Code keeps session worktrees under
    // .claude/worktrees, each a whole copy of the repository, and the default
    // glob would run their tests three times over as this project's own.
    include: ["tests/**/*.test.{ts,mjs}"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**", "**/src-tauri/target/**"],
  },
});
