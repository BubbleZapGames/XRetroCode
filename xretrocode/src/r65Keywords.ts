/**
 * Words an R65 identifier can't be: the negative lookahead on `IDENT` in the
 * compiler's grammar (R65 `r65/compiler/frontend/grammar.lark`), which covers
 * keywords, reserved words, macro fragment types, primitive types and registers.
 */
export const RESERVED_WORDS = new Set([
  'include_bytes', 'include_asm', 'macro_rules', 'continue', 'include', 'return', 'struct', 'static',
  'break', 'const', 'while', 'union', 'enum', 'impl', 'self', 'loop', 'type', 'else', 'near', 'let',
  'mut', 'asm', 'far', 'fn', 'if', 'as', 'abstract', 'override', 'unsized', 'virtual', 'typeof',
  'unsafe', 'extern', 'become', 'async', 'await', 'match', 'where', 'super', 'trait', 'yield', 'crate',
  'final', 'move', 'priv', 'Self', 'box', 'dyn', 'for', 'mod', 'pub', 'ref', 'try', 'use', 'in', 'do',
  'expr', 'ident', 'literal', 'ty', 'reg', 'tt', 'STATUS', 'DBR', 'PBR', 'bool', 'u16', 'i16', 'u8',
  'i8', 'true', 'false', 'A', 'B', 'X', 'Y', 'D', 'S',
]);

export const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
