// @hashrock/ono ships no types for its browser compiler yet.
declare module "@hashrock/ono/browser/compiler" {
  export function compileProject(
    files: Record<string, string>,
    entryPoint?: string
  ): Promise<{ html: string; css: string }>;
}
