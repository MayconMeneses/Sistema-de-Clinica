import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    env: { LOGIN_IP_MAX: '100000' }, // todos os testes saem do mesmo IP; o teste do limite por IP define o seu próprio valor
  },
});
