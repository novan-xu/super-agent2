import { parse, type ParserOptions } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import type { Node } from "@babel/types";
import { shownAttributes } from "./attributes.js";
import { type Finding, hasLetters, literalMessage, Positions, reasonOf, unparsable } from "./finding.js";

export type JsxDialect = "jsx" | "tsx";

function pluginsFor(dialect: JsxDialect): NonNullable<ParserOptions["plugins"]> {
  return dialect === "tsx" ? ["typescript", "jsx"] : ["jsx"];
}

function keyOf(key: Node, computed: boolean): string | undefined {
  if (key.type === "Identifier" && !computed) {
    return key.name;
  }
  if (key.type === "StringLiteral") {
    return key.value;
  }
  return undefined;
}

function constantInit(path: NodePath): NodePath | undefined {
  if (!path.isIdentifier()) {
    return undefined;
  }
  const binding = path.scope.getBinding(path.node.name);
  const declarator = binding?.path;
  if (binding?.constant && declarator?.isVariableDeclarator()) {
    const init = declarator.get("init");
    return init.node ? init : undefined;
  }
  return undefined;
}

function unwrap(path: NodePath): NodePath {
  if (path.isTSAsExpression() || path.isTSSatisfiesExpression() || path.isTSNonNullExpression() || path.isParenthesizedExpression()) {
    return unwrap(path.get("expression"));
  }
  const init = constantInit(path);
  return init ? unwrap(init) : path;
}

export function findJsxText(text: string, dialect: JsxDialect): Finding[] {
  const positions = new Positions(text);
  const findings: Finding[] = [];

  const report = (offset: number, value: string) => {
    findings.push({ ...positions.at(offset), message: literalMessage(value) });
  };

  const reportString = (node: Node, value: string) => {
    if (hasLetters(value) && node.start !== null && node.start !== undefined) {
      report(node.start, value);
    }
  };

  const flowReturns = (path: NodePath, seen: Set<Node>): void => {
    if (path.isArrowFunctionExpression() && !path.get("body").isBlockStatement()) {
      flow(path.get("body"), seen);
      return;
    }
    path.traverse({
      Function(inner) {
        inner.skip();
      },
      ReturnStatement(statement) {
        const argument = statement.get("argument");
        if (argument.node) {
          flow(argument, seen);
        }
      },
    });
  };

  const flowMember = (path: NodePath, seen: Set<Node>): void => {
    if (!path.isMemberExpression() && !path.isOptionalMemberExpression()) {
      return;
    }
    const object = path.get("object");
    const property = path.node.property;
    const name = path.node.computed
      ? property.type === "StringLiteral"
        ? property.value
        : undefined
      : property.type === "Identifier"
        ? property.name
        : undefined;
    const target = unwrap(object);
    if (name !== undefined && target.isObjectExpression()) {
      for (const entry of target.get("properties")) {
        if (entry.isObjectProperty() && keyOf(entry.node.key, entry.node.computed) === name) {
          flow(entry.get("value"), seen);
        }
      }
      return;
    }
    flow(object, seen);
  };

  const flow = (path: NodePath, seen: Set<Node>): void => {
    const node = path.node;
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (path.isStringLiteral()) {
      reportString(path.node, path.node.value);
    } else if (path.isTemplateLiteral()) {
      for (const quasi of path.get("quasis")) {
        reportString(quasi.node, quasi.node.value.cooked ?? quasi.node.value.raw);
      }
      for (const expression of path.get("expressions")) {
        flow(expression, seen);
      }
    } else if (path.isConditionalExpression()) {
      flow(path.get("consequent"), seen);
      flow(path.get("alternate"), seen);
    } else if (path.isLogicalExpression()) {
      flow(path.get("left"), seen);
      flow(path.get("right"), seen);
    } else if (path.isBinaryExpression({ operator: "+" })) {
      flow(path.get("left"), seen);
      flow(path.get("right"), seen);
    } else if (path.isSequenceExpression()) {
      const last = path.get("expressions").at(-1);
      if (last) {
        flow(last, seen);
      }
    } else if (path.isArrayExpression()) {
      for (const element of path.get("elements")) {
        if (element.node) {
          flow(element, seen);
        }
      }
    } else if (path.isObjectExpression()) {
      for (const property of path.get("properties")) {
        if (property.isObjectProperty()) {
          flow(property.get("value"), seen);
        }
      }
    } else if (path.isIdentifier()) {
      const init = constantInit(path);
      if (init) {
        flow(init, seen);
      }
    } else if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      flowMember(path, seen);
    } else if (path.isCallExpression() || path.isOptionalCallExpression()) {
      for (const argument of path.get("arguments")) {
        if (argument.isArrowFunctionExpression() || argument.isFunctionExpression()) {
          flowReturns(argument, seen);
        }
      }
    } else if (
      path.isParenthesizedExpression() ||
      path.isTSAsExpression() ||
      path.isTSSatisfiesExpression() ||
      path.isTSNonNullExpression() ||
      path.isTSTypeAssertion()
    ) {
      flow(path.get("expression"), seen);
    }
  };

  try {
    const file = parse(text, {
      sourceType: "unambiguous",
      plugins: pluginsFor(dialect),
      errorRecovery: true,
      attachComment: false,
    });
    traverse(file, {
      JSXText(path) {
        const start = path.node.start ?? 0;
        const raw = text.slice(start, path.node.end ?? start);
        const index = raw.search(/\p{L}/u);
        if (index >= 0 && hasLetters(path.node.value)) {
          report(start + index, path.node.value);
        }
      },
      JSXExpressionContainer(path) {
        if (path.parentPath.isJSXAttribute()) {
          return;
        }
        const expression = path.get("expression");
        if (!expression.isJSXEmptyExpression()) {
          flow(expression, new Set());
        }
      },
      JSXAttribute(path) {
        const name = path.node.name;
        const spelled = name.type === "JSXNamespacedName" ? `${name.namespace.name}:${name.name.name}` : name.name;
        if (!shownAttributes.has(spelled)) {
          return;
        }
        const value = path.get("value");
        if (value.isStringLiteral()) {
          reportString(value.node, value.node.value);
        } else if (value.isJSXExpressionContainer()) {
          const expression = value.get("expression");
          if (!expression.isJSXEmptyExpression()) {
            flow(expression, new Set());
          }
        }
      },
    });
  } catch (error) {
    const location = (error as { loc?: { line: number; column: number } }).loc;
    findings.push(unparsable(location?.line ?? 1, (location?.column ?? 0) + 1, reasonOf(error)));
  }
  return findings;
}
