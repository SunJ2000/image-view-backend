import ts from 'typescript';

// Vite's default TS transform does not emit Nest's constructor injection metadata.
// Use the existing TypeScript compiler, avoiding an extra native compiler runtime.
export function typescriptMetadataPlugin() {
  return {
    name: 'typescript-decorator-metadata',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.endsWith('.ts') || id.includes('node_modules')) return;
      return ts.transpileModule(code, {
        fileName: id,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          sourceMap: true,
        },
      }).outputText;
    },
  };
}
