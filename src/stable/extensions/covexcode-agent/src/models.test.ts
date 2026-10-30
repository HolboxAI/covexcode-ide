import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	COVEXCODE_MODELS,
	envVarForModel,
	isByokModel,
	missingApiKeyMarkdown,
	resolveEffectiveModelName,
	resolveModelDescriptor,
	secretKeyForProvider,
} from './models';

test('models catalog contains required models with agent capabilities', () => {
	assert.ok(COVEXCODE_MODELS.length >= 8, 'should have multiple models');

	for (const model of COVEXCODE_MODELS) {
		assert.ok(model.id, 'model must have an id');
		assert.ok(model.name, 'model must have a name');
		assert.ok(model.capabilities.toolCalling, `${model.id} must support toolCalling for agent mode`);
		assert.strictEqual(model.capabilities.agentMode, true, `${model.id} must support agentMode`);
		assert.ok(model.maxInputTokens > 0, `${model.id} must specify maxInputTokens`);
		assert.ok(model.maxOutputTokens > 0, `${model.id} must specify maxOutputTokens`);
	}
});

test('covexcode included models include DeepSeek Pro and Flash', () => {
	const pro = COVEXCODE_MODELS.find(m => m.id === 'deepseek-v4-pro');
	assert.ok(pro, 'deepseek-v4-pro must exist');
	assert.strictEqual(pro.name, 'DeepSeek Pro');
	assert.strictEqual(pro.isBYOK, false);
	assert.strictEqual(pro.isDefault, true);

	const flash = COVEXCODE_MODELS.find(m => m.id === 'deepseek-v4-flash');
	assert.ok(flash, 'deepseek-v4-flash must exist');
	assert.strictEqual(flash.name, 'DeepSeek Flash');
	assert.strictEqual(flash.isBYOK, false);
});

test('auto model is defined and selectable', () => {
	const auto = COVEXCODE_MODELS.find(m => m.id === 'auto');
	assert.ok(auto, 'auto model must exist');
	assert.strictEqual(auto.name, 'Auto');
	assert.strictEqual(auto.isBYOK, false);
});

test('byok models include OpenAI models and direct DeepSeek V3/R1', () => {
	const byokIds = [
		'gpt-4o',
		'gpt-4o-mini',
		'o1',
		'o3-mini',
		'deepseek-chat',
		'deepseek-reasoner',
	];

	for (const id of byokIds) {
		const m = COVEXCODE_MODELS.find(model => model.id === id);
		assert.ok(m, `BYOK model ${id} must exist`);
		assert.strictEqual(m.isBYOK, true, `${id} must be flagged as BYOK`);
		assert.ok(m.envVar, `${id} must have an envVar specified`);
	}
});

test('legacy fallback model is hidden from picker', () => {
	const legacy = COVEXCODE_MODELS.find(m => m.id === 'covexcode');
	assert.ok(legacy, 'covexcode fallback model must exist');
	assert.strictEqual(legacy.isUserSelectable, false, 'legacy model should not be user selectable');
});

test('resolveModelDescriptor resolves IDs case-insensitively and falls back to auto', () => {
	assert.strictEqual(resolveModelDescriptor('deepseek-v4-pro').id, 'deepseek-v4-pro');
	assert.strictEqual(resolveModelDescriptor('GPT-4O').id, 'gpt-4o');
	assert.strictEqual(resolveModelDescriptor('AUTO').id, 'auto');
	assert.strictEqual(resolveModelDescriptor(undefined).id, 'auto');
	assert.strictEqual(resolveModelDescriptor('nonexistent-model').id, 'auto');
});

test('resolveEffectiveModelName maps auto and undefined to default execution model', () => {
	assert.strictEqual(resolveEffectiveModelName(undefined), 'deepseek-v4-pro');
	assert.strictEqual(resolveEffectiveModelName('auto'), 'deepseek-v4-pro');
	assert.strictEqual(resolveEffectiveModelName('auto', 'deepseek-v4-flash'), 'deepseek-v4-flash');
	assert.strictEqual(resolveEffectiveModelName('gpt-4o'), 'gpt-4o');
	assert.strictEqual(resolveEffectiveModelName('covexcode'), 'deepseek-v4-pro');
});

test('isByokModel correctly identifies BYOK models', () => {
	assert.strictEqual(isByokModel('deepseek-v4-pro'), false);
	assert.strictEqual(isByokModel('auto'), false);
	assert.strictEqual(isByokModel('gpt-4o'), true);
	assert.strictEqual(isByokModel('o3-mini'), true);
});

test('envVarForModel returns expected environment variables', () => {
	assert.strictEqual(envVarForModel('gpt-4o'), 'OPENAI_API_KEY');
	assert.strictEqual(envVarForModel('deepseek-chat'), 'DEEPSEEK_API_KEY');
	assert.strictEqual(envVarForModel('deepseek-v4-pro'), undefined);
});

test('secretKeyForProvider returns expected keys', () => {
	assert.strictEqual(secretKeyForProvider('covexcode'), 'covexcode.apiKey');
	assert.strictEqual(secretKeyForProvider('openai'), 'covexcode.apiKey.openai');
	assert.strictEqual(secretKeyForProvider('deepseek'), 'covexcode.apiKey.deepseek');
});

test('missingApiKeyMarkdown contains model name and actionable links', () => {
	const desc = resolveModelDescriptor('gpt-4o');
	const md = missingApiKeyMarkdown(desc);
	assert.ok(md.includes('GPT-4o'));
	assert.ok(md.includes('OPENAI_API_KEY'));
	assert.ok(md.includes('command:covexcode.setApiKey'));
	assert.ok(md.includes('DeepSeek Pro'));
});
