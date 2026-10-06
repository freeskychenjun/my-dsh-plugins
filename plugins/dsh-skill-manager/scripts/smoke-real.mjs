// 真实目录只读冒烟：扫 ~/.agents/skills 与 ~/.dsh/skills，打印统计与问题项
import { buildRoots, scanInventory } from '../lib/skills.js';

const roots = buildRoots({
  dshHome: process.env.DSH_HOME,
  agentsHome: process.env.DSH_AGENTS_HOME,
  customSkillDirs: [String.raw`C:\Users\Administrator\.agents\skills\hydrology`],
  includeDefaultRoots: true,
});
console.log('roots:', roots.map(r => `${r.id}(${r.rank}) -> ${r.path}`));
const inventory = await scanInventory(roots);
console.log(`\ntotal skills: ${inventory.skills.length}`);
for (const root of inventory.roots) console.log(`  root ${root.id}: exists=${root.exists} count=${root.count}`);
const invalid = inventory.skills.filter(s => !s.valid);
console.log(`\ninvalid (${invalid.length}):`);
for (const s of invalid) console.log(`  ${s.skillMdPath}\n    ${s.problems.join(' | ')}`);
const shadowed = inventory.skills.filter(s => s.valid && !s.effective);
console.log(`\nshadowed (${shadowed.length}):`);
for (const s of shadowed) console.log(`  ${s.name}: ${s.rootLabel} <- 被 ${s.shadowedBy.rootLabel} 遮蔽`);
const mismatch = inventory.skills.filter(s => s.locatorMismatch);
console.log(`\nlocator mismatch (${mismatch.length}):`);
for (const s of mismatch) console.log(`  ${s.locator} != ${s.name}`);
const disabled = inventory.skills.filter(s => s.modelInvocable === false || s.userInvocable === false);
console.log(`\ninvocation-restricted (${disabled.length}):`);
for (const s of disabled) console.log(`  ${s.name}: model=${s.modelInvocable} user=${s.userInvocable}`);
console.log(`\ngeneratedAt: ${inventory.generatedAt}`);
