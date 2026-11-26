'use strict';

// Migration rules for moving a CommonJS repo to TypeScript, checked on every PR.
// Config (default .github/ts-migration.json, override with MIGRATION_CONFIG):
//   { "doc": "...", "label": "typescript", "tsOnlyDirs": ["src/services/"], "inProgress": ["src/a.js"] }
// Rules:
//  - no new .js files in a tsOnlyDirs folder
//  - a converted file has no .js copy next to its .ts
//  - files in inProgress only change in a PR that carries the migration label
// Env: BASE_REF (PR base branch, default main), PR_LABELS (comma separated).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const configPath = process.env.MIGRATION_CONFIG || '.github/ts-migration.json';
const config = JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8'));
const tsOnlyDirs = config.tsOnlyDirs || [];
const inProgress = config.inProgress || [];
const label = config.label || 'typescript';
const doc = config.doc || configPath;
const base = 'origin/' + (process.env.BASE_REF || 'main');
const labels = (process.env.PR_LABELS || '').split(',').map((l) => l.trim()).filter(Boolean);
const hasMigrationLabel = labels.indexOf(label) > -1;

function git(args) {
  return execSync('git ' + args, { cwd: root }).toString().split('\n').filter(Boolean);
}

function changedFiles() {
  return git('diff --name-status --find-renames ' + base + '...HEAD').map((line) => {
    const parts = line.split('\t');
    const status = parts[0].charAt(0);
    return { status, file: parts[parts.length - 1], from: status === 'R' ? parts[1] : null };
  });
}

const problems = [];

changedFiles().forEach((c) => {
  const inTsOnlyDir = tsOnlyDirs.some((dir) => c.file.startsWith(dir));
  if (c.file.endsWith('.js') && inTsOnlyDir && (c.status === 'A' || c.status === 'R')) {
    problems.push(c.file + ': migration rule: new files in ' + tsOnlyDirs.join(', ') + ' are .ts, not .js.');
  }
  [c.file, c.from].filter(Boolean).forEach((file) => {
    if (inProgress.indexOf(file) > -1 && !hasMigrationLabel) {
      problems.push(file + ': migration rule: this file is queued for conversion to .ts, so it only changes in a migration PR (label "' + label + '").');
    }
  });
});

const tracked = new Set(git('ls-files'));
tracked.forEach((file) => {
  if (file.endsWith('.ts') && tracked.has(file.slice(0, -3) + '.js')) {
    problems.push(file.slice(0, -3) + '.js: migration rule: ' + file + ' is already converted, so there is no .js copy; edit the .ts file.');
  }
});

if (problems.length) {
  console.log('Migration rules not met (' + doc + '):');
  problems.forEach((p) => console.log('  - ' + p));
  console.log('If an AI coding agent made this change, it should stop here and tell the person using it to read ' + doc + '.');
  process.exit(1);
}
console.log('Migration rules met.');
