/**
 * Регрессионные тесты сборки под Vercel.
 *
 * Билдер Vercel (@vercel/node) компилирует каждый .ts файл через
 * `ts.transpileModule` и НЕ бандлит. Поэтому относительные импорты должны
 * указывать на итоговые .js-файлы: в лямбду попадает `lib/cache.js`, а
 * импорт вида `../lib/cache.ts` приводит к
 * `ERR_MODULE_NOT_FOUND` -> Vercel отвечает 500 FUNCTION_INVOCATION_FAILED.
 *
 * За переписывание расширений отвечает опция tsconfig
 * `rewriteRelativeImportExtensions: true`. Тест проверяет, что после
 * трансляции в импортах не осталось .ts-спецификаторов.
 *
 *   node --test test/build.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function compilerOptions() {
  const configPath = path.join(root, 'tsconfig.json');
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
    compilerOptions?: Record<string, unknown>;
  };
  const options = raw.compilerOptions ?? {};

  // Значения, которые задаёт сам билдер Vercel поверх tsconfig проекта.
  return {
    ...options,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: false,
  } as ts.CompilerOptions;
}

function sourceFiles(dir: string): string[] {
  const absolute = path.join(root, dir);
  return readdirSync(absolute)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => path.join(absolute, f));
}

test('tsconfig включает rewriteRelativeImportExtensions', () => {
  const raw = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions?: Record<string, unknown>;
  };
  assert.equal(
    raw.compilerOptions?.rewriteRelativeImportExtensions,
    true,
    'без этой опции билдер Vercel оставит импорты с .ts и функция упадёт',
  );
});

test('после трансляции в импортах не остаётся .ts-спецификаторов', () => {
  const options = compilerOptions();
  const files = [...sourceFiles('api'), ...sourceFiles('lib')];
  assert.ok(files.length > 0, 'не найдено ни одного исходника');

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const output = ts.transpileModule(source, { fileName: file, compilerOptions: options }).outputText;

    const specifiers = [...output.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] as string);
    for (const specifier of specifiers) {
      assert.ok(
        !specifier.endsWith('.ts'),
        `${path.relative(root, file)}: импорт "${specifier}" указывает на .ts — ` +
          'в лямбде Vercel такого файла нет, будет ERR_MODULE_NOT_FOUND',
      );
    }
  }
});

test('каждый импорт из api/ указывает на файл, который попадёт в лямбду', () => {
  const options = compilerOptions();
  const emitted = new Set<string>();

  for (const file of [...sourceFiles('api'), ...sourceFiles('lib')]) {
    const source = readFileSync(file, 'utf8');
    const output = ts.transpileModule(source, { fileName: file, compilerOptions: options }).outputText;
    for (const match of output.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(file), match[1] as string);
      emitted.add(path.relative(root, target));
    }
  }

  for (const target of emitted) {
    const candidates = [
      path.join(root, target),
      path.join(root, target.replace(/\.js$/, '.ts')),
    ];
    assert.ok(
      candidates.some((c) => readdirSync(path.dirname(c)).includes(path.basename(c))),
      `импорт на ${target} не разрешается ни в .js, ни в .ts`,
    );
  }
});
