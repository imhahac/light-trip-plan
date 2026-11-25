module.exports = {
    root: true,
    env: {
        browser: true,
        es2022: true,
        node: true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
            jsx: true,
        },
    },
    settings: {
        react: {
            version: 'detect',
        },
    },
    plugins: ['react-hooks'],
    extends: [],
    rules: {
        'no-undef': 'error',
        'no-const-assign': 'error',
        'no-dupe-keys': 'error',
        'no-duplicate-case': 'error',
        'no-unreachable': 'error',
        'valid-typeof': 'error',
        'no-eval': 'error',
        'no-implied-eval': 'error',
        'no-new-func': 'error',
        'react-hooks/rules-of-hooks': 'error',
    },
};
