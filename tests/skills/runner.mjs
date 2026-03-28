#!/usr/bin/env node
// skill-test-runner v0.1 — Snapshot-based regression tests for 1C skill scripts
// Usage: node tests/skills/runner.mjs [filter] [--update-snapshots] [--runtime python] [--json report.json]

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync,
         readdirSync, statSync, cpSync, copyFileSync } from 'fs';
import { join, resolve, dirname, relative, basename, extname } from 'path';
import { tmpdir } from 'os';

// ─── Paths ──────────────────────────────────────────────────────────────────

const ROOT      = resolve(dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/i, '$1'));
const REPO_ROOT = resolve(ROOT, '../..');
const SKILLS    = resolve(REPO_ROOT, '.claude/skills');
const CASES     = resolve(ROOT, 'cases');
const CACHE     = resolve(ROOT, '.cache');
const FIXTURES  = resolve(ROOT, 'fixtures');

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { filter: null, updateSnapshots: false, runtime: 'powershell', jsonReport: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--update-snapshots') { args.updateSnapshots = true; continue; }
    if (a === '--runtime' && rest[i + 1]) { args.runtime = rest[++i]; continue; }
    if (a === '--json' && rest[i + 1]) { args.jsonReport = rest[++i]; continue; }
    if (!a.startsWith('--') && !args.filter) { args.filter = a.replace(/\\/g, '/'); continue; }
  }
  return args;
}

// ─── Case discovery ─────────────────────────────────────────────────────────

function discoverCases(filter) {
  const results = [];
  if (!existsSync(CASES)) return results;

  for (const skillDir of readdirSync(CASES)) {
    const skillPath = join(CASES, skillDir);
    if (!statSync(skillPath).isDirectory()) continue;

    const skillJsonPath = join(skillPath, '_skill.json');
    if (!existsSync(skillJsonPath)) continue;

    const skillConfig = JSON.parse(readFileSync(skillJsonPath, 'utf8'));

    for (const file of readdirSync(skillPath)) {
      if (file.startsWith('_') || !file.endsWith('.json')) continue;
      const caseName = file.replace(/\.json$/, '');
      const caseId = `cases/${skillDir}/${caseName}`;

      // Apply filter
      if (filter) {
        const f = filter.replace(/\.json$/, '');
        if (!caseId.startsWith(f) && !caseId.includes(f)) continue;
      }

      const casePath = join(skillPath, file);
      const caseData = JSON.parse(readFileSync(casePath, 'utf8'));
      const snapshotDir = join(skillPath, `${caseName}.snapshot`);

      results.push({
        id: caseId,
        name: caseData.name || caseName,
        skillDir,
        skillConfig,
        caseData,
        casePath,
        snapshotDir,
      });
    }
  }

  return results;
}

// ─── Setup / Fixtures ───────────────────────────────────────────────────────

function ensureSetup(setupName, runtime) {
  if (setupName === 'none' || !setupName) return null;

  if (setupName.startsWith('fixture:')) {
    const fixturePath = join(FIXTURES, setupName.slice('fixture:'.length));
    if (!existsSync(fixturePath)) throw new Error(`Fixture not found: ${fixturePath}`);
    return fixturePath;
  }

  if (setupName === 'empty-config') {
    const cached = join(CACHE, 'empty-config');
    if (existsSync(cached)) return cached;

    mkdirSync(cached, { recursive: true });
    const script = resolveScript('cf-init/scripts/cf-init', runtime);
    try {
      execSkillRaw(runtime, script, ['-Name', 'TestConfig', '-OutputDir', cached]);
    } catch (e) {
      rmSync(cached, { recursive: true, force: true });
      throw new Error(`Failed to create empty-config fixture: ${e.message}`);
    }
    return cached;
  }

  if (setupName === 'base-config') {
    const cached = join(CACHE, 'base-config');
    if (existsSync(cached)) return cached;
    throw new Error('base-config fixture not found. Run integration tests first.');
  }

  throw new Error(`Unknown setup: ${setupName}`);
}

// ─── Script resolution ──────────────────────────────────────────────────────

function resolveScript(scriptRelPath, runtime) {
  const ext = runtime === 'python' ? '.py' : '.ps1';
  const full = join(SKILLS, scriptRelPath + ext);
  if (!existsSync(full)) throw new Error(`Script not found: ${full}`);
  return full;
}

function execSkillRaw(runtime, scriptPath, args) {
  if (runtime === 'python') {
    return execFileSync(process.env.PYTHON || 'python', [scriptPath, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    });
  }
  // PowerShell
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, ...args
  ], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
  });
}

// ─── Workspace ──────────────────────────────────────────────────────────────

function createWorkspace(fixturePath) {
  const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
  if (fixturePath) {
    cpSync(fixturePath, tmp, { recursive: true });
  }
  return tmp;
}

function cleanupWorkspace(tmp) {
  rmSync(tmp, { recursive: true, force: true });
}

// ─── Arg building ───────────────────────────────────────────────────────────

function buildArgs(skillConfig, caseData, workDir, inputFilePath, runtime) {
  const args = [];
  const scriptPath = resolveScript(skillConfig.script, runtime);

  for (const mapping of skillConfig.args) {
    args.push(mapping.flag);

    switch (mapping.from) {
      case 'inputFile':
        args.push(inputFilePath);
        break;
      case 'workDir':
        args.push(workDir);
        break;
      case 'outputPath':
        args.push(join(workDir, caseData.outputPath || ''));
        break;
      case 'switch':
        // flag already pushed, no value needed — remove the flag and re-push conditionally
        args.pop(); // remove flag, will re-add if switch is active
        if (caseData[mapping.flag.replace(/^-/, '')] !== false) {
          args.push(mapping.flag);
        }
        break;
      default:
        if (mapping.from.startsWith('case.')) {
          const field = mapping.from.slice(5);
          const val = caseData[field] ?? caseData.params?.[field] ?? '';
          args.push(String(val));
        } else if (mapping.from === 'literal') {
          args.push(mapping.value || '');
        }
    }
  }

  return { scriptPath, args };
}

// ─── Snapshot normalization ─────────────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function normalizeContent(text, config) {
  // Strip BOM
  let s = text.replace(/^\uFEFF/, '');
  // Normalize line endings
  s = s.replace(/\r\n/g, '\n');

  // Normalize UUIDs
  if (config?.normalizeUuids) {
    const uuidMap = new Map();
    let counter = 0;
    s = s.replace(UUID_RE, (match) => {
      const lower = match.toLowerCase();
      if (!uuidMap.has(lower)) {
        counter++;
        uuidMap.set(lower, `UUID-${String(counter).padStart(3, '0')}`);
      }
      return uuidMap.get(lower);
    });
  }

  return s;
}

// ─── Snapshot comparison ────────────────────────────────────────────────────

function listFilesRecursive(dir, base = '') {
  const result = [];
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      result.push(...listFilesRecursive(full, rel));
    } else {
      result.push(rel);
    }
  }
  return result.sort();
}

function compareSnapshot(workDir, snapshotDir, snapshotConfig) {
  if (!existsSync(snapshotDir)) return { match: true, reason: 'no snapshot (skipped)' };

  const snapshotFiles = listFilesRecursive(snapshotDir);
  if (snapshotFiles.length === 0) return { match: true, reason: 'empty snapshot (skipped)' };

  const diffs = [];

  for (const relFile of snapshotFiles) {
    const actualPath = join(workDir, relFile);
    const snapshotPath = join(snapshotDir, relFile);

    if (!existsSync(actualPath)) {
      diffs.push({ file: relFile, type: 'missing', detail: 'file not found in output' });
      continue;
    }

    const actualRaw = readFileSync(actualPath, 'utf8');
    const snapshotRaw = readFileSync(snapshotPath, 'utf8');

    const actual = normalizeContent(actualRaw, snapshotConfig);
    const expected = normalizeContent(snapshotRaw, snapshotConfig);

    if (actual !== expected) {
      // Find first differing line
      const actualLines = actual.split('\n');
      const expectedLines = expected.split('\n');
      let diffLine = -1;
      for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i++) {
        if (actualLines[i] !== expectedLines[i]) { diffLine = i + 1; break; }
      }
      diffs.push({
        file: relFile,
        type: 'content',
        line: diffLine,
        expected: expectedLines[diffLine - 1]?.substring(0, 120),
        actual: actualLines[diffLine - 1]?.substring(0, 120),
      });
    }
  }

  if (diffs.length === 0) return { match: true };
  return { match: false, diffs };
}

function updateSnapshot(workDir, snapshotDir, snapshotConfig) {
  // Remove old snapshot
  if (existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true, force: true });

  // Determine which files to snapshot — all files in workDir that were created by the skill
  // For "workDir" root mode, we need to figure out what files the skill added.
  // Strategy: snapshot all files in workDir (the fixture files + skill output).
  // On comparison, only files IN the snapshot are checked, so this is safe.
  const files = listFilesRecursive(workDir);
  if (files.length === 0) return;

  mkdirSync(snapshotDir, { recursive: true });
  for (const relFile of files) {
    const src = join(workDir, relFile);
    const dst = join(snapshotDir, relFile);
    mkdirSync(dirname(dst), { recursive: true });

    const raw = readFileSync(src, 'utf8');
    const normalized = normalizeContent(raw, snapshotConfig);
    writeFileSync(dst, normalized, 'utf8');
  }
}

// ─── Run a single case ──────────────────────────────────────────────────────

function runCase(testCase, opts) {
  const { skillConfig, caseData, snapshotDir } = testCase;
  const t0 = performance.now();
  const setupName = caseData.setup || skillConfig.setup || 'none';
  let workDir = null;
  let inputFile = null;

  try {
    // 1. Setup workspace
    const fixturePath = ensureSetup(setupName, opts.runtime);
    workDir = createWorkspace(fixturePath);

    // 2. Write input JSON if needed
    if (caseData.input !== undefined) {
      inputFile = join(workDir, '__input.json');
      writeFileSync(inputFile, JSON.stringify(caseData.input, null, 2), 'utf8');
    }

    // 3. Build CLI args and execute
    const { scriptPath, args } = buildArgs(skillConfig, caseData, workDir, inputFile, opts.runtime);
    let stdout = '', stderr = '', exitCode = 0;

    try {
      stdout = execSkillRaw(opts.runtime, scriptPath, args);
    } catch (e) {
      exitCode = e.status ?? 1;
      stdout = e.stdout || '';
      stderr = e.stderr || '';
    }

    // Remove temp input file from workDir before snapshot comparison
    if (inputFile && existsSync(inputFile)) rmSync(inputFile);

    // 4. Assertions
    const errors = [];

    if (caseData.expectError) {
      // Negative case — expect failure
      if (exitCode === 0) {
        errors.push('Expected error (non-zero exit) but got exitCode=0');
      }
      if (typeof caseData.expectError === 'string' && !stderr.includes(caseData.expectError)) {
        errors.push(`Expected stderr to contain "${caseData.expectError}", got: ${stderr.substring(0, 200)}`);
      }
    } else {
      // Positive case — expect success
      if (exitCode !== 0) {
        errors.push(`exitCode=${exitCode}\nstdout: ${stdout.substring(0, 300)}\nstderr: ${stderr.substring(0, 300)}`);
      }

      // expect.files
      if (caseData.expect?.files) {
        for (const f of caseData.expect.files) {
          if (!existsSync(join(workDir, f))) {
            errors.push(`Expected file not found: ${f}`);
          }
        }
      }

      // expect.stdoutContains
      if (caseData.expect?.stdoutContains) {
        if (!stdout.includes(caseData.expect.stdoutContains)) {
          errors.push(`stdout does not contain "${caseData.expect.stdoutContains}"`);
        }
      }

      // Snapshot comparison
      if (errors.length === 0 && !caseData.expectError) {
        const snapshotConfig = skillConfig.snapshot || {};
        if (opts.updateSnapshots) {
          updateSnapshot(workDir, snapshotDir, snapshotConfig);
        } else {
          const cmp = compareSnapshot(workDir, snapshotDir, snapshotConfig);
          if (!cmp.match && cmp.diffs) {
            for (const d of cmp.diffs) {
              if (d.type === 'missing') {
                errors.push(`Snapshot: file missing — ${d.file}`);
              } else {
                errors.push(`Snapshot: ${d.file}:${d.line} differs\n  expected: ${d.expected}\n  actual:   ${d.actual}`);
              }
            }
          }
        }
      }
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    return {
      id: testCase.id,
      name: testCase.name,
      passed: errors.length === 0,
      errors,
      elapsed: `${elapsed}s`,
      snapshotUpdated: opts.updateSnapshots && !caseData.expectError,
    };

  } catch (e) {
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    return {
      id: testCase.id,
      name: testCase.name,
      passed: false,
      errors: [`Runner error: ${e.message}`],
      elapsed: `${elapsed}s`,
    };
  } finally {
    if (workDir) cleanupWorkspace(workDir);
  }
}

// ─── Reporter ───────────────────────────────────────────────────────────────

function printReport(results, opts) {
  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed);

  console.log('');
  for (const r of results) {
    const icon = r.passed ? '\u2713' : '\u2717';
    const suffix = r.snapshotUpdated ? ' [snapshot updated]' : '';
    console.log(`  ${icon} ${r.name} (${r.elapsed})${suffix}`);
    if (!r.passed) {
      for (const err of r.errors) {
        for (const line of err.split('\n')) {
          console.log(`    ${line}`);
        }
      }
    }
  }

  console.log('');
  console.log(`  Passed: ${passed.length} | Failed: ${failed.length} | Total: ${results.length}`);
  console.log('');

  if (opts.jsonReport) {
    const report = {
      timestamp: new Date().toISOString(),
      runtime: opts.runtime,
      passed: passed.length,
      failed: failed.length,
      total: results.length,
      results: results.map(r => ({
        id: r.id,
        name: r.name,
        passed: r.passed,
        elapsed: r.elapsed,
        errors: r.errors.length > 0 ? r.errors : undefined,
      })),
    };
    writeFileSync(opts.jsonReport, JSON.stringify(report, null, 2), 'utf8');
    console.log(`  Report: ${opts.jsonReport}`);
  }

  return failed.length === 0;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv);
  const cases = discoverCases(opts.filter);

  if (cases.length === 0) {
    console.log('No test cases found.' + (opts.filter ? ` Filter: "${opts.filter}"` : ''));
    process.exit(0);
  }

  console.log(`\nRunning ${cases.length} test(s)... [runtime: ${opts.runtime}]`);

  // Ensure cache dir exists
  mkdirSync(CACHE, { recursive: true });

  const results = [];
  for (const tc of cases) {
    results.push(runCase(tc, opts));
  }

  const allPassed = printReport(results, opts);
  process.exit(allPassed ? 0 : 1);
}

main();
