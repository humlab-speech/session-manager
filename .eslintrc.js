module.exports = {
  parser: "@babel/eslint-parser",
  env: { node: true, es2020: true },
  extends: ['eslint:recommended', 'prettier'],
  parserOptions: { ecmaVersion: 2020, requireConfigFile: false },
  rules: {
    'no-unused-vars': 'off'
  }
};