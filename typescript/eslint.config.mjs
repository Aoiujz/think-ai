import stylistic from '@stylistic/eslint-plugin';
import parser from '@typescript-eslint/parser';

function insideArgument(node) {
  for (let child = node, parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type === 'ArrowFunctionExpression' && parent.body.type === 'BlockStatement') {
      return false;
    }
    if (['FunctionExpression', 'FunctionDeclaration', 'ObjectExpression', 'ArrayExpression'].includes(parent.type)) {
      return false;
    }
    if (['CallExpression', 'NewExpression'].includes(parent.type) && parent.arguments.includes(child)) {
      return true;
    }
  }
  return false;
}

// Keep the official layout rule, with argument boundaries taking priority.
const chainRule = stylistic.rules['newline-per-chained-call'];
const standaloneChains = {
  ...chainRule,
  create(context) {
    const listeners = chainRule.create(context);
    return Object.fromEntries(
      Object.entries(listeners).map(([selector, listener]) => [
        selector,
        (node) => {
          if (!insideArgument(node)) {
            listener(node);
          }
        },
      ]),
    );
  },
};

export default [
  {
    name: 'thinkai-layout',
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: {
      '@stylistic': stylistic,
      thinkai: { rules: { 'newline-per-chained-call': standaloneChains } },
    },
    rules: {
      'thinkai/newline-per-chained-call': ['error', { ignoreChainWithDepth: 1 }],
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
    },
  },
];
