// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    globals: true,
  },
});
