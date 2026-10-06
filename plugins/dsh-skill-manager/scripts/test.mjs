/**
 * Unit tests for dsh-skill-manager pure logic (lib/skills.js + fence in lib/index.js).
 * Run: node scripts/test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyInvocationToContent,
  buildRoots,
  buildSkillDocument,
  parseFrontmatterBoolean,
  parseFrontmatterFields,
  parseSkillFile,
  rewriteInvocationKeys,
  scanInventory,
  splitFrontmatter,
  validateFrontmatter,
  yamlScalar,
} from '../lib/skills.js';
import { locateSkillMd } from '../lib/index.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (cause) {
    failed += 1;
    console.error(`FAIL - ${name}\n  ${cause?.stack ?? cause}`);
  }
}

// ── splitFrontmatter ────────────────────────────────────────────────────────
await test('splitFrontmatter basic', () => {
  const split = splitFrontmatter('---\nname: a\ndescription: b\n---\n\nbody');
  assert.equal(split.fmText, 'name: a\ndescription: b');
  assert.equal(split.body, '\nbody');
});

await test('splitFrontmatter CRLF and no trailing newline', () => {
  const split = splitFrontmatter('---\r\nname: a\r\ndescription: b\r\n---');
  assert.equal(split.fmText, 'name: a\r\ndescription: b');
  assert.equal(split.body, '');
});

await test('splitFrontmatter absent', () => {
  assert.equal(splitFrontmatter('# hi\n'), undefined);
  assert.equal(splitFrontmatter('--- \nname: a\n'), undefined);
});

// ── parseFrontmatterFields ──────────────────────────────────────────────────
await test('scalar fields incl quoted', () => {
  const fields = parseFrontmatterFields('name: pdf\ndescription: "处理: PDF 文件"\nwhenToUse: \'引用场景\'');
  const by = Object.fromEntries(fields.map(f => [f.key, f]));
  assert.equal(by.name.text, 'pdf');
  assert.equal(by.description.text, '处理: PDF 文件');
  assert.equal(by.whenToUse.text, '引用场景');
});

await test('complex field detection (metadata object)', () => {
  const fields = parseFrontmatterFields('name: a\nmetadata:\n  version: 1\ndescription: x');
  const meta = fields.find(f => f.key === 'metadata');
  assert.equal(meta.kind, 'complex');
});

await test('folded block scalar (description: >)', () => {
  const fm = 'name: agent-reach\ndescription: >\n  第一行文字\n  接着一行\n\n  第二段\nwhenToUse: x';
  const fields = parseFrontmatterFields(fm);
  const description = fields.find(f => f.key === 'description');
  assert.equal(description.kind, 'scalar');
  assert.equal(description.text, '第一行文字 接着一行\n第二段');
  const v = validateFrontmatter(fields);
  assert.equal(v.valid, true);
  assert.equal(v.description, '第一行文字 接着一行\n第二段');
});

await test('literal block scalar with strip chomping (>-/|-)', () => {
  const fields = parseFrontmatterFields('name: a\ndescription: |-\n  L1\n  L2\nwhenToUse: w');
  const description = fields.find(f => f.key === 'description');
  assert.equal(description.text, 'L1\nL2');
});

await test('multi-line double-quoted scalar', () => {
  const fm = 'name: a\ndescription: "开头一句\n  换行继续一句"\nwhenToUse: w';
  const fields = parseFrontmatterFields(fm);
  const description = fields.find(f => f.key === 'description');
  assert.equal(description.kind, 'scalar');
  assert.equal(description.text, '开头一句 换行继续一句');
});

await test('boolean spellings per provider rules', () => {
  const mk = value => parseFrontmatterFields(`disable-model-invocation: ${value}`);
  for (const spell of ['true', 'True', 'TRUE', 'yes', 'on', '1']) {
    const r = parseFrontmatterBoolean(mk(spell), 'disable-model-invocation');
    assert.equal(r.state, 'present', spell);
    assert.equal(r.value, true, spell);
  }
  for (const spell of ['false', 'FALSE', 'no', 'off', '0']) {
    const r = parseFrontmatterBoolean(mk(spell), 'disable-model-invocation');
    assert.equal(r.state, 'present', spell);
    assert.equal(r.value, false, spell);
  }
  const bad = parseFrontmatterBoolean(parseFrontmatterFields('disable-model-invocation: maybe'), 'disable-model-invocation');
  assert.equal(bad.state, 'error');
});

// ── validateFrontmatter ─────────────────────────────────────────────────────
await test('valid frontmatter', () => {
  const v = validateFrontmatter(parseFrontmatterFields('name: my-skill\ndescription: 做\n'));
  assert.equal(v.valid, true);
  assert.equal(v.modelInvocable, true);
  assert.equal(v.userInvocable, true);
});

await test('invalid names rejected like provider', () => {
  for (const name of ['MySkill', 'my_skill', '-x', 'a--b', 'a-', '中文']) {
    const v = validateFrontmatter(parseFrontmatterFields(`name: ${name}\ndescription: d`));
    assert.equal(v.valid, false, name);
  }
});

await test('missing description rejected', () => {
  const v = validateFrontmatter(parseFrontmatterFields('name: a'));
  assert.equal(v.valid, false);
  assert.ok(v.problems.some(p => p.includes('description')));
});

await test('legacy camelCase keys rejected', () => {
  const v = validateFrontmatter(parseFrontmatterFields('name: a\ndescription: d\ndisableModelInvocation: true'));
  assert.equal(v.valid, false);
  assert.ok(v.problems.some(p => p.includes('disableModelInvocation')));
});

await test('invocation resolution', () => {
  const v = validateFrontmatter(parseFrontmatterFields('name: a\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false'));
  assert.equal(v.valid, true);
  assert.equal(v.modelInvocable, false);
  assert.equal(v.userInvocable, false);
});

// ── serialization round trips ───────────────────────────────────────────────
await test('yamlScalar quotes when needed', () => {
  assert.equal(yamlScalar('plain'), 'plain');
  assert.equal(yamlScalar('带冒号: 值'), '"带冒号: 值"');
  assert.equal(yamlScalar('true'), '"true"');
  assert.equal(yamlScalar('123'), '"123"');
  assert.equal(yamlScalar('#hash'), '"#hash"');
});

await test('buildSkillDocument → parseSkillFile valid', () => {
  const doc = buildSkillDocument({ name: 'demo-skill', description: '演示: 一个技能', whenToUse: '当要演示时', body: '# demo\n\nhi' });
  const parsed = parseSkillFile(doc);
  assert.equal(parsed.valid, true, parsed.problems?.join(';'));
  assert.equal(parsed.name, 'demo-skill');
  assert.equal(parsed.description, '演示: 一个技能');
  assert.equal(parsed.whenToUse, '当要演示时');
  assert.ok(doc.includes('# demo'));
});

await test('rewriteInvocationKeys adds and removes', () => {
  const base = 'name: a\ndescription: d';
  assert.equal(rewriteInvocationKeys(base, {}), base);
  const withKeys = rewriteInvocationKeys(base, { disableModelInvocation: true, userInvocable: false });
  assert.equal(withKeys, 'name: a\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false');
  assert.equal(rewriteInvocationKeys(withKeys, {}), base);
});

await test('rewriteInvocationKeys never splits a folded description block', () => {
  const fm = 'name: agent-reach\ndescription: >\n  第一段\n  继续\n\n  第二段\ntriggers:\n  - x';
  const next = rewriteInvocationKeys(fm, { disableModelInvocation: true, userInvocable: true });
  // insertion must come after the whole folded block, not between header and block
  const expected = 'name: agent-reach\ndescription: >\n  第一段\n  继续\n\n  第二段\ndisable-model-invocation: true\ntriggers:\n  - x';
  assert.equal(next, expected);
  const round = rewriteInvocationKeys(next, {});
  assert.equal(round, fm);
});

await test('applyInvocationToContent preserves body and unknown keys', () => {
  const content = '---\nname: a\ndescription: d\nmetadata:\n  version: 2\n---\n\n正文保留\n';
  const next = applyInvocationToContent(content, { disableModelInvocation: true, userInvocable: true });
  assert.ok(next.includes('disable-model-invocation: true'));
  assert.ok(next.includes('metadata:'));
  assert.ok(next.includes('正文保留'));
  assert.ok(next.includes('version: 2'));
  assert.ok(!next.includes('user-invocable'));
  const parsed = parseSkillFile(next);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.modelInvocable, false);
  const back = applyInvocationToContent(next, { disableModelInvocation: false, userInvocable: true });
  assert.ok(!back.includes('disable-model-invocation'));
  assert.ok(back.includes('metadata:'));
  assert.ok(back.includes('正文保留'));
});

// ── fence ───────────────────────────────────────────────────────────────────
await test('locateSkillMd fence', () => {
  const roots = buildRoots({ dshHome: 'C:\\fake\\.dsh', agentsHome: 'C:\\fake\\.agents', customSkillDirs: [], includeDefaultRoots: true });
  const userAgents = roots.find(r => r.id === 'user-agents');
  assert.ok(locateSkillMd(roots, join(userAgents.path, 'pdf', 'SKILL.md')), 'bundle inside root');
  assert.ok(locateSkillMd(roots, join(userAgents.path, 'pdf.md')), 'flat inside root');
  assert.equal(locateSkillMd(roots, join(userAgents.path, 'pdf', 'sub', 'SKILL.md')), undefined, 'nested too deep');
  assert.equal(locateSkillMd(roots, join(userAgents.path, '..', 'pdf', 'SKILL.md')), undefined, 'escape rejected');
  assert.equal(locateSkillMd(roots, join(userAgents.path, 'SKILL.md')), undefined, 'root-level SKILL.md rejected');
  assert.equal(locateSkillMd(roots, 'C:\\other\\pdf\\SKILL.md'), undefined, 'outside rejected');
});

// ── buildRoots ──────────────────────────────────────────────────────────────
await test('buildRoots rank order and dedupe', () => {
  const roots = buildRoots({ dshHome: 'C:\\h1', agentsHome: 'C:\\h2', customSkillDirs: ['C:\\extra'], includeDefaultRoots: true, projectRoot: 'C:\\proj' });
  assert.deepEqual(roots.map(r => r.id), ['project-dsh', 'project-agents', 'custom-C:\\extra', 'user-dsh', 'user-agents']);
  const ranks = roots.map(r => r.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  const dedup = buildRoots({ dshHome: 'C:\\same', agentsHome: 'C:\\same', customSkillDirs: [], includeDefaultRoots: true });
  assert.equal(dedup.length, 1);
  const noDefaults = buildRoots({ dshHome: 'C:\\h', agentsHome: 'C:\\a', customSkillDirs: ['C:\\x'], includeDefaultRoots: false });
  assert.deepEqual(noDefaults.map(r => r.id), ['custom-C:\\x']);
});

// ── scanInventory on fixtures ───────────────────────────────────────────────
const fixture = await mkdtemp(join(tmpdir(), 'dshsm-test-'));
try {
  const rootA = join(fixture, 'rootA'); // rank 300 (custom)
  const rootB = join(fixture, 'rootB'); // rank 400 (custom, later) — we'll assign ranks via buildRoots ordering
  await mkdir(join(rootA, 'winner'), { recursive: true });
  await writeFile(join(rootA, 'winner', 'SKILL.md'), '---\nname: dup\ndescription: 应胜出\n---\n\nA');
  await mkdir(join(rootB, 'loser'), { recursive: true });
  await writeFile(join(rootB, 'loser', 'SKILL.md'), '---\nname: dup\ndescription: 应被遮蔽\n---\n\nB');
  await mkdir(join(rootB, 'flat-one'), { recursive: true }).catch(() => {});
  await writeFile(join(rootB, 'flat-skill.md'), '---\nname: flat-skill\ndescription: 平铺\n---\n\nF');
  await mkdir(join(rootB, 'bad-name'), { recursive: true });
  await writeFile(join(rootB, 'bad-name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: 坏名字\n---\n\nX');
  await mkdir(join(rootB, 'no-desc'), { recursive: true });
  await writeFile(join(rootB, 'no-desc', 'SKILL.md'), '---\nname: no-desc\n---\n\nY');
  await mkdir(join(rootB, 'mismatch'), { recursive: true });
  await writeFile(join(rootB, 'mismatch', 'SKILL.md'), '---\nname: other-name\ndescription: 名字不一致\n---\n\nZ');
  await mkdir(join(rootB, 'hidden'), { recursive: true });
  await writeFile(join(rootB, 'hidden', 'SKILL.md'), '---\nname: hidden\ndescription: 隐藏\ndisable-model-invocation: true\n---\n\nH');

  await test('scanInventory shadow + validity + mismatch', async () => {
    const roots = [
      { id: 'custom-rootA', label: 'A', path: rootA, rank: 300, kind: 'custom' },
      { id: 'custom-rootB', label: 'B', path: rootB, rank: 350, kind: 'custom' },
    ];
    const inventory = await scanInventory(roots);
    const byName = new Map(inventory.skills.map(s => [`${s.name}@${s.rootId}`, s]));
    const winner = byName.get('dup@custom-rootA');
    const loser = byName.get('dup@custom-rootB');
    assert.equal(winner.effective, true);
    assert.equal(loser.effective, false);
    assert.equal(loser.shadowedBy.rootId, 'custom-rootA');
    const bad = byName.get('Bad_Name@custom-rootB');
    assert.ok(bad !== undefined, 'invalid skill surfaces with its frontmatter name');
    assert.equal(bad.valid, false);
    assert.ok(bad.problems.some(p => p.includes('kebab-case')));
    const noDesc = inventory.skills.find(s => s.locator === 'no-desc');
    assert.equal(noDesc.valid, false);
    const mismatch = inventory.skills.find(s => s.locator === 'mismatch');
    assert.equal(mismatch.valid, true);
    assert.equal(mismatch.locatorMismatch, true);
    assert.equal(mismatch.name, 'other-name');
    const flat = inventory.skills.find(s => s.locator === 'flat-skill');
    assert.equal(flat.kind, 'flat');
    assert.equal(flat.name, 'flat-skill');
    const hidden = inventory.skills.find(s => s.name === 'hidden');
    assert.equal(hidden.modelInvocable, false);
    assert.equal(hidden.userInvocable, true);
    const counts = new Map(inventory.roots.map(r => [r.id, r.count]));
    assert.equal(counts.get('custom-rootA'), 1);
    assert.equal(counts.get('custom-rootB'), 6);
  });
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
