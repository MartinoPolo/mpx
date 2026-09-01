import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

async function sourceText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? sourceText(path.join(root, entry.name))
          : entry.name.endsWith('.ts')
            ? readFile(path.join(root, entry.name), 'utf8')
            : '',
      ),
    )
  ).join('\n');
}

async function rootSourceText(root: string): Promise<string> {
  const files = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts'),
  );
  return (
    await Promise.all(files.map((file) => readFile(path.join(root, file.name), 'utf8')))
  ).join('\n');
}

function runtimeSessionsReferences(source: ts.SourceFile): string[] {
  const references: string[] = [];
  const sessionsModule = (node: ts.Expression): boolean =>
    ts.isStringLiteral(node) && node.text === '@mpx/sessions';
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && sessionsModule(node.moduleSpecifier)) {
      const clause = node.importClause;
      const namedBindings = clause?.namedBindings;
      const onlyTypeSpecifiers =
        clause?.name === undefined &&
        namedBindings !== undefined &&
        ts.isNamedImports(namedBindings) &&
        namedBindings.elements.length > 0 &&
        namedBindings.elements.every((specifier) => specifier.isTypeOnly);
      if (!clause?.isTypeOnly && !onlyTypeSpecifiers) {
        references.push(node.getText(source));
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (sessionsModule(node.moduleSpecifier)) {
        const onlyTypeSpecifiers =
          node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((specifier) => specifier.isTypeOnly);
        if (!node.isTypeOnly && !onlyTypeSpecifiers) {
          references.push(node.getText(source));
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      sessionsModule(node.moduleReference.expression)
    ) {
      references.push(node.getText(source));
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      sessionsModule(node.arguments[0])
    ) {
      references.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

describe('@mpx/application architecture', () => {
  it('imports no concrete provider, runtime adapter, Windows, or CLI modules', async () => {
    const source = await rootSourceText(path.resolve(import.meta.dirname, '../../src'));
    expect(source).not.toMatch(/@mpx\/(?:provider-|runtime-(?:claude|pi)|windows)|apps\/cli/u);
  });

  it('keeps Node imports and NodeJS types out of the provider-neutral root', async () => {
    const source = await rootSourceText(path.resolve(import.meta.dirname, '../../src'));
    expect(source).not.toMatch(/from ['"]node:|\bNodeJS\./u);
  });

  it('has no runtime dependency on the Node-backed sessions package from the root', async () => {
    const root = path.resolve(import.meta.dirname, '../../src');
    const files = (await readdir(root, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts'),
    );
    const violations = (
      await Promise.all(
        files.map(async (file) => {
          const text = await readFile(path.join(root, file.name), 'utf8');
          const source = ts.createSourceFile(
            file.name,
            text,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
          );
          return runtimeSessionsReferences(source).map((reference) => `${file.name}: ${reference}`);
        }),
      )
    ).flat();

    expect(violations).toEqual([]);
  });

  it('keeps CLI internals out of both neutral and Node application modules', async () => {
    const source = await sourceText(path.resolve(import.meta.dirname, '../../src'));
    expect(source).not.toMatch(/apps\/cli/u);
  });

  it('exposes provider-neutral operation facades from the importable package root', async () => {
    const application = await import('../../src/index.js');
    expect(application).toMatchObject({
      AccountApplicationService: expect.any(Function),
      LifecycleApplicationService: expect.any(Function),
      LaunchApplicationService: expect.any(Function),
      InstallApplicationService: expect.any(Function),
      MigrationApplicationService: expect.any(Function),
      SessionApplicationService: expect.any(Function),
      SessionResumeLaunchApplicationService: expect.any(Function),
      createProjectApplicationService: expect.any(Function),
      createProviderApplicationService: expect.any(Function),
      createSkillApplicationService: expect.any(Function),
    });
  });

  it('exports Node adapters without leaking them from the neutral root', async () => {
    const node = await import('../../src/node/index.js');
    const root = await import('../../src/index.js');
    expect(node).toMatchObject({
      createNodeAccountApplicationService: expect.any(Function),
      createNodeInstallApplicationService: expect.any(Function),
      createNodeInstallProtocolInput: expect.any(Function),
      createNodeLocalIssueViewRebuilder: expect.any(Function),
      createNodeMigrationApplicationService: expect.any(Function),
      createProductionSessionBranchRuntimeAdapter: expect.any(Function),
      createWindowsTerminalBranchAdapter: expect.any(Function),
      diagnoseNodeSessionBranchAdapters: expect.any(Function),
      diagnoseSessionBranchAdapters: expect.any(Function),
      createPiAuthAvailabilityProbe: expect.any(Function),
      createDefaultSbxDiagnostics: expect.any(Function),
      createProductionSbxExecutionAdapter: expect.any(Function),
      createProductionSessionDockerResumeAdmission: expect.any(Function),
      diagnoseConfiguredF2Proof: expect.any(Function),
      loadProductionSbxProofSources: expect.any(Function),
      planProductionSbxExecution: expect.any(Function),
      createNodeConfiguredProviderApplicationService: expect.any(Function),
      createNodeProviderService: expect.any(Function),
      NodePrivateRouteMaterializer: expect.any(Function),
      NodeProviderProcessExecutor: expect.any(Function),
      NodeRepositorySelectorResolver: expect.any(Function),
    });
    for (const name of [
      'createNodeAccountApplicationService',
      'createNodeInstallApplicationService',
      'createNodeInstallProtocolInput',
      'createNodeLocalIssueViewRebuilder',
      'createNodeMigrationApplicationService',
      'createProductionSessionBranchRuntimeAdapter',
      'createWindowsTerminalBranchAdapter',
      'diagnoseNodeSessionBranchAdapters',
      'diagnoseSessionBranchAdapters',
      'createPiAuthAvailabilityProbe',
      'createDefaultSbxDiagnostics',
      'createProductionSbxExecutionAdapter',
      'createProductionSessionDockerResumeAdmission',
      'diagnoseConfiguredF2Proof',
      'loadProductionSbxProofSources',
      'planProductionSbxExecution',
      'createNodeConfiguredProviderApplicationService',
      'createNodeProviderService',
      'NodePrivateRouteMaterializer',
      'NodeProviderProcessExecutor',
      'NodeRepositorySelectorResolver',
    ]) {
      expect(root).not.toHaveProperty(name);
    }
  });

  it('keeps concrete provider and route class declarations out of CLI context', async () => {
    const context = await readFile(
      path.resolve(import.meta.dirname, '../../../../apps/cli/src/context.ts'),
      'utf8',
    );
    expect(context).not.toMatch(
      /(?:class|abstract class)\s+(?:NodeProviderProcessExecutor|NodeRepositorySelectorResolver|NodePrivateRouteMaterializer)\b/u,
    );
  });

  it('keeps the Phase-J implementation out of the CLI source tree', async () => {
    const cliRoot = path.resolve(import.meta.dirname, '../../../../apps/cli/src');
    await expect(access(path.join(cliRoot, 'migration.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const source = await sourceText(cliRoot);
    expect(source).not.toContain('captureSourceDrift');
    expect(source).not.toContain('persistMigrationObservation');
  });

  it('uses installer contracts as types only from the neutral install service', async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, '../../src/install-application-service.ts'),
      'utf8',
    );
    const parsed = ts.createSourceFile(
      'install-application-service.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const installerImports = parsed.statements.filter(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === '@mpx/installer',
    );
    expect(installerImports).toHaveLength(1);
    expect(installerImports[0]?.importClause?.isTypeOnly).toBe(true);
  });

  it('keeps generic application operation contracts out of provider-specific services', async () => {
    const contracts = await readFile(
      path.resolve(import.meta.dirname, '../../src/contracts.ts'),
      'utf8',
    );
    const providerService = await readFile(
      path.resolve(import.meta.dirname, '../../src/provider-application-service.ts'),
      'utf8',
    );
    expect(contracts).toContain('export interface ApplicationOperationResult<T>');
    expect(providerService).not.toContain('interface ApplicationOperationResult');
  });
});
