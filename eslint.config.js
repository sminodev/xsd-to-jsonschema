// @ts-check
// Configuration of typescript-eslint with type information (https://typescript-eslint.io/getting-started/typed-linting).
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist', 'coverage'] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  // Configuration files are plain JavaScript outside the TypeScript project.
  { files: ['*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
