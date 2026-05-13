import test from 'node:test';
import assert from 'node:assert/strict';
import { getFamilyPlanSquadPreset } from './agent-room.js';

test('preset da squad família tem coordenador e especialistas ativos', () => {
  const preset = getFamilyPlanSquadPreset();

  assert.equal(preset.key, 'family_plan');
  assert.equal(preset.coordinatorAgent, 'iara-family-coordenador');
  assert.ok(Array.isArray(preset.agents));
  assert.ok(preset.agents.length >= 4);

  const names = preset.agents.map((agent) => agent.name);
  assert.ok(names.includes('iara-family-coordenador'));
  assert.ok(names.includes('iara-family-produto'));
  assert.ok(names.includes('iara-family-cx'));
  assert.ok(names.includes('iara-family-ops'));
  assert.ok(names.includes('iara-family-qa'));

  const allActive = preset.agents.every((agent) => agent.active !== false);
  assert.equal(allActive, true);
  assert.ok(preset.defaultInstruction.length > 20);
});
