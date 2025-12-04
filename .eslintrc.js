module.exports = {
  parser: "@babel/eslint-parser",
  env: { node: true, es2020: true },
  extends: ['eslint:recommended', 'prettier'],
  parserOptions: { ecmaVersion: 2020, requireConfigFile: false },
  rules: {
    // Add any custom rules here if needed
  }
};