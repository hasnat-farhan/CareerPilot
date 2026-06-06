/**
 * Minimal local type declaration for `mammoth`.
 *
 * `mammoth` does NOT ship its own `.d.ts` files and there is no
 * `@types/mammoth` package on npm, so importing it from a strict
 * TypeScript project fails on `Cannot find module 'mammoth'`. We
 * declare only the surface we use (`extractRawText`); if you need
 * the converter API, extend this file rather than pulling a
 * hand-maintained full shim.
 *
 * Why a local `.d.ts` and not `// @ts-ignore`:
 *   - Keeps the route's `mammoth.extractRawText({ buffer })` call
 *     type-checked.
 *   - Scoped to `lib/cv/` so it doesn't pollute the global type
 *     namespace.
 */
declare module "mammoth" {
  export interface ExtractRawTextOptions {
    buffer: Buffer | Uint8Array;
  }

  export interface ExtractRawTextResult {
    value: string;
    messages: Array<{
      type: string;
      message: string;
    }>;
  }

  export function extractRawText(
    options: ExtractRawTextOptions,
  ): Promise<ExtractRawTextResult>;
}
