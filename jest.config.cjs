/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  modulePathIgnorePatterns: ['/dist/', '/node_modules/', '/.next/'],
  testPathIgnorePatterns: ['/dist/', '/node_modules/', '/.next/', '/apps/admin/'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Keep ts-jest fast and free of cross-package type-resolution surprises
        // (those run under `pnpm typecheck`); jest only needs the JS output.
        isolatedModules: true,
        diagnostics: false,
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          esModuleInterop: true,
          strict: false,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          moduleResolution: 'node',
        },
      },
    ],
  },
  moduleNameMapper: {
    '^@pagerunner/shared$': '<rootDir>/packages/shared/src/index.ts',
    '^@pagerunner/agent-tools$': '<rootDir>/packages/agent-tools/src/index.ts',
    '^@pagerunner/db$': '<rootDir>/packages/db/src/index.ts',
    '^@pagerunner/sdk$': '<rootDir>/packages/sdk/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    'apps/control-plane/src/**/*.ts',
    'apps/runner/src/**/*.ts',
    '!**/*.test.ts',
    '!**/dist/**',
  ],
  coverageThreshold:
    process.env.CI === 'true'
      ? {
          global: { lines: 80, statements: 80, functions: 70, branches: 60 },
        }
      : undefined,
};
