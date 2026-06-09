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
      'no-restricted-imports': ['warn', {
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
      'no-restricted-syntax': ['warn', {
        selector: 'MemberExpression[object.name="prisma"][property.name="storedFile"]',
        message:
          'Direct prisma.storedFile access. Prefer getStoredFilePathForProject() or getStoredFilePath().',
      }],
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
