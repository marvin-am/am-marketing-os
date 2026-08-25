/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  arrowParens: 'always',
  endOfLine: 'lf',
  overrides: [
    { files: '*.md', options: { proseWrap: 'preserve' } },
    { files: '*.sql', options: { printWidth: 120 } },
  ],
};
