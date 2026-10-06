// 干跑：对真实文件应用 invocation 重写（不落盘），确认折叠描述等结构不损坏
import { readFile } from 'node:fs/promises';
import { applyInvocationToContent, parseSkillFile } from '../lib/skills.js';

const files = [
  String.raw`C:\Users\Administrator\.agents\skills\agent-reach\SKILL.md`,       // description: > 折叠
  String.raw`C:\Users\Administrator\.agents\skills\decrypt-office-pdf\SKILL.md`, // 双引号长描述
  String.raw`C:\Users\Administrator\.agents\skills\grill-me\SKILL.md`,          // 已有 disable-model-invocation
];
for (const file of files) {
  console.error('processing', file.split('\\').slice(-2)[0]);
  const content = await readFile(file, 'utf8');
  const before = parseSkillFile(content);
  console.error('  parseSkillFile valid:', before.valid, JSON.stringify(before.problems));
  let next;
  try {
    next = applyInvocationToContent(content, { disableModelInvocation: true, userInvocable: true });
  } catch (cause) {
    console.error('  apply FAILED:', cause.message);
    continue;
  }
  const after = parseSkillFile(next);
  const okName = before.name === after.name;
  const okDesc = before.description === after.description;
  const modelOff = after.modelInvocable === false;
  const back = applyInvocationToContent(next, { disableModelInvocation: false, userInvocable: true });
  const roundTrip = back.replace('disable-model-invocation: true\n', '') === content.replace('disable-model-invocation: true\n', '');
  console.log(`${file.split('\\').slice(-2)[0]}: name=${okName} desc=${okDesc} modelOff=${modelOff} roundTrip=${roundTrip}`);
  if (before.whenToUse !== undefined) console.log(`  whenToUse preserved: ${before.whenToUse === after.whenToUse}`);
  if (!okDesc) console.log(`  BEFORE: ${JSON.stringify(before.description?.slice(0, 80))}\n  AFTER:  ${JSON.stringify(after.description?.slice(0, 80))}`);
}
