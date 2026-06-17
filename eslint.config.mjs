import coreWebVitals from 'eslint-config-next/core-web-vitals';

const config = [
  ...coreWebVitals,
  {
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
    },
  },
  // ── StoredFile security: prevent dangerous imports in API routes ──
  {
    files: ['src/app/api/**/*.ts', 'src/app/api/**/*.tsx', 'src/pages/api/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: '@/lib/stored-file',
          importNames: ['getAllStoredPaths'],
          message:
            'getAllStoredPaths() returns ALL storage paths with no filtering. ' +
            'It MUST NOT be called from API routes.',
        }, {
          name: '@/lib/stored-file',
          importNames: ['getStoredFilePath'],
          message:
            'Prefer getStoredFilePathForProject() in API routes — it requires ' +
            'projectId and verifies entity ownership.',
        }],
      }],
      'no-restricted-syntax': ['error', {
        selector: 'MemberExpression[object.name="prisma"][property.name="storedFile"]',
        message:
          'Direct prisma.storedFile access. Prefer getStoredFilePathForProject() or getStoredFilePath().',
      }],
    },
  },
  // ── Storage path safety: prevent inline path construction outside of builders ──
  {
    files: [
      'src/app/api/**/*.ts',
      'src/app/api/**/*.tsx',
      'src/pages/api/**/*.ts',
      'src/lib/**/*.ts',
    ],
    ignores: [
      '**/project-storage-paths.ts',
      '**/storage-sanitize.ts',
      '**/storage.ts',
      '**/accounting/file-storage.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error',
        // Catch path.posix.join(...) — storage paths MUST use builders.
        // (path.join() is allowed — it's used for non-storage filesystem ops.)
        {
          selector: 'CallExpression[callee.object.property.name="posix"][callee.property.name="join"]',
          message:
            'Do not construct storage paths with path.posix.join(). ' +
            'Use builder functions from @/lib/project-storage-paths instead.',
        },
      ],
    },
  },
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'coverage/**',
      'dist/**',
      'next-env.d.ts',
    ],
  },
];

export default config;
