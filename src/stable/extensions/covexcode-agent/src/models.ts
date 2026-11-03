/**
 * Models supported by Covexcode IDE.
 *
 * Provides:
 * 1. Covexcode Included models (DeepSeek Pro, DeepSeek Flash) powered by Covexcode credits.
 * 2. Auto model routing ("Auto - Best for task").
 * 3. Bring-Your-Own-Key (BYOK) models for OpenAI (all models) and DeepSeek direct (when credit is exhausted).
 */

export interface CovexcodeModelCapabilities {
	readonly toolCalling: boolean;
	readonly imageInput: boolean;
	readonly agentMode?: boolean;
}

export interface CovexcodeModelDescriptor {
	readonly id: string;
	readonly name: string;
	readonly family: string;
	readonly detail: string;
	readonly version: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly isBYOK: boolean;
	readonly provider: string;
	readonly envVar?: string;
	readonly isDefault?: boolean;
	readonly isUserSelectable?: boolean;
	readonly capabilities: CovexcodeModelCapabilities;
}

export const COVEXCODE_MODELS: readonly CovexcodeModelDescriptor[] = [
	// --- Included with Covexcode ---
	{
		id: 'deepseek-v4-pro',
		name: 'DeepSeek Pro',
		family: 'DeepSeek',
		detail: 'Pro · Included',
		version: '1.0.0',
		maxInputTokens: 128_000,
		maxOutputTokens: 8_192,
		isBYOK: false,
		isDefault: true,
		provider: 'covexcode',
		capabilities: { toolCalling: true, imageInput: true, agentMode: true },
	},
	{
		id: 'deepseek-v4-flash',
		name: 'DeepSeek Flash',
		family: 'DeepSeek',
		detail: 'Fast · Included',
		version: '1.0.0',
		maxInputTokens: 128_000,
		maxOutputTokens: 8_192,
		isBYOK: false,
		provider: 'covexcode',
		capabilities: { toolCalling: true, imageInput: true, agentMode: true },
	},

	// --- Auto option (below included models) ---
	{
		id: 'auto',
		name: 'Auto',
		family: 'Auto',
		detail: 'Auto · Best for task',
		version: '1.0.0',
		maxInputTokens: 128_000,
		maxOutputTokens: 8_192,
		isBYOK: false,
		provider: 'covexcode',
		capabilities: { toolCalling: true, imageInput: true, agentMode: true },
	},

	// --- Bring Your Own Key (BYOK) Models ---
	// OpenAI models (User provides their own OpenAI API key)
	{
		id: 'gpt-4o',
		name: 'GPT-4o',
		family: 'OpenAI',
		detail: 'OpenAI · BYOK',
		version: '1.0.0',
		maxInputTokens: 128_000,
		maxOutputTokens: 4_096,
		isBYOK: true,
		provider: 'openai',
		envVar: 'OPENAI_API_KEY',
		capabilities: { toolCalling: true, imageInput: true, agentMode: true },
	},
	{
		id: 'gpt-4o-mini',
		name: 'GPT-4o mini',
		family: 'OpenAI',
		detail: 'Fast · BYOK',
		version: '1.0.0',
		maxInputTokens: 128_000,
		maxOutputTokens: 16_384,
		isBYOK: true,
		provider: 'openai',
		envVar: 'OPENAI_API_KEY',
		capabilities: { toolCalling: true, imageInput: true, agentMode: true },
	},
	{
		id: 'o1',
		name: 'o1',
		family: 'OpenAI',
		detail: 'Reasoning · BYOK',
		version: '1.0.0',
		maxInputTokens: 200_000,
		maxOutputTokens: 100_000,
		isBYOK: true,
		provider: 'openai',
		envVar: 'OPENAI_API_KEY',
		capabilities: { toolCalling: true, imageInput: true, agentMode: true },
	},
	{
		id: 'o3-mini',
		name: 'o3-mini',
		family: 'OpenAI',
		detail: 'Reasoning · BYOK',
		version: '1.0.0',
		maxInputTokens: 200_000,
		maxOutputTokens: 100_000,
		isBYOK: true,
		provider: 'openai',
		envVar: 'OPENAI_API_KEY',
		capabilities: { toolCalling: true, imageInput: false, agentMode: true },
	},
	{
		id: 'gpt-5.6-sol',
		name: 'GPT-5.6 Sol',
		family: 'OpenAI',
		detail: 'OpenAI · BYOK',
		version: '1.0.0',
		maxInputTokens: 200_000,
		maxOutputTokens: 16_384,
		isBYOK: true,
		provider: 'openai',
		envVar: 'OPENAI_API_KEY',
		capabilities: { toolCalling: true, imageInput: true, agentMode: true },
	},
	{
		id: 'gpt-5.6-terra',
		name: 'GPT-5.6 Terra',
		family: 'OpenAI',
		detail: 'OpenAI · BYOK',
		version: '1.0.0',
		maxInputTokens: 200_000,
		maxOutputTokens: 16_384,
		isBYOK: true,
		provider: 'openai',
		envVar: 'OPENAI_API_KEY',
		capabilities: { toolCalling: true, imageInput: true, agentMode: true },
	},
	{
		id: 'gpt-5.6-luna',
		name: 'GPT-5.6 Luna',
		family: 'OpenAI',
		detail: 'Fast · BYOK',
		version: '1.0.0',
		maxInputTokens: 200_000,
		maxOutputTokens: 16_384,
		isBYOK: true,
		provider: 'openai',
		envVar: 'OPENAI_API_KEY',
		capabilities: { toolCalling: true, imageInput: true, agentMode: true },
	},

	// DeepSeek Direct (User provides their own DeepSeek API key once credits run out)
	{
		id: 'deepseek-chat',
		name: 'DeepSeek V3',
		family: 'DeepSeek',
		detail: 'DeepSeek API Key',
		version: '1.0.0',
		maxInputTokens: 128_000,
		maxOutputTokens: 8_192,
		isBYOK: true,
		provider: 'deepseek',
		envVar: 'DEEPSEEK_API_KEY',
		capabilities: { toolCalling: true, imageInput: false, agentMode: true },
	},
	{
		id: 'deepseek-reasoner',
		name: 'DeepSeek R1',
		family: 'DeepSeek',
		detail: 'Reasoning · DeepSeek API Key',
		version: '1.0.0',
		maxInputTokens: 128_000,
		maxOutputTokens: 8_192,
		isBYOK: true,
		provider: 'deepseek',
		envVar: 'DEEPSEEK_API_KEY',
		capabilities: { toolCalling: true, imageInput: false, agentMode: true },
	},

	// --- Legacy Fallback (not selectable in UI, but resolves existing configs) ---
	{
		id: 'covexcode',
		name: 'covexcode',
		family: 'covexcode',
		detail: 'Default',
		version: '1.0.0',
		maxInputTokens: 128_000,
		maxOutputTokens: 8_192,
		isBYOK: false,
		isUserSelectable: false,
		provider: 'covexcode',
		capabilities: { toolCalling: true, imageInput: true, agentMode: true },
	},
];

const DEFAULT_INCLUDED_MODEL = 'deepseek-v4-pro';

/**
 * Look up a model by id, defaulting to 'auto'.
 */
export function resolveModelDescriptor(modelId?: string): CovexcodeModelDescriptor {
	if (!modelId) {
		return COVEXCODE_MODELS.find(m => m.id === 'auto') ?? COVEXCODE_MODELS[0];
	}
	const normalized = modelId.toLowerCase().trim();
	const match = COVEXCODE_MODELS.find(m => m.id.toLowerCase() === normalized);
	return match ?? COVEXCODE_MODELS.find(m => m.id === 'auto') ?? COVEXCODE_MODELS[0];
}

/**
 * Resolves the concrete model name to send to the backend / CLI.
 * If 'auto' or unspecified, returns the configured model or 'deepseek-v4-pro'.
 */
export function resolveEffectiveModelName(modelId?: string, configuredModel?: string): string {
	if (!modelId || modelId === 'auto') {
		const cfg = configuredModel?.trim();
		return cfg && cfg !== 'auto' && cfg !== 'covexcode' ? cfg : DEFAULT_INCLUDED_MODEL;
	}
	if (modelId === 'covexcode') {
		return DEFAULT_INCLUDED_MODEL;
	}
	return modelId;
}

/**
 * Returns true if the model requires user's own API key (BYOK).
 */
export function isByokModel(modelId?: string): boolean {
	const desc = resolveModelDescriptor(modelId);
	return desc.isBYOK;
}

/**
 * Returns the environment variable name for a model (e.g. OPENAI_API_KEY, DEEPSEEK_API_KEY).
 */
export function envVarForModel(modelId?: string): string | undefined {
	const desc = resolveModelDescriptor(modelId);
	return desc.envVar;
}

/**
 * Returns the secret storage key used for a provider/model's API key.
 */
export function secretKeyForProvider(provider: string): string {
	if (provider === 'covexcode' || !provider) {
		return 'covexcode.apiKey';
	}
	return `covexcode.apiKey.${provider.toLowerCase()}`;
}

/**
 * Returns user-facing markdown informing them that an API key is required for this model.
 */
export function missingApiKeyMarkdown(model: CovexcodeModelDescriptor): string {
	const envHint = model.envVar ? ` (or export \`${model.envVar}\`)` : '';
	const setKeyLink = `command:covexcode.setApiKey?${encodeURIComponent(JSON.stringify([model.provider]))}`;
	return [
		`### 🔑 API Key Required for ${model.name}`,
		'',
		`To use **${model.name}**, please configure your API key for ${model.family}${envHint}.`,
		'',
		`[Set API Key](${setKeyLink}) • [Change Provider / Model](command:covexcode.changeProvider)`,
		'',
		`*(Or switch back to **DeepSeek Pro** / **DeepSeek Flash** to use your included Covexcode credits without an API key)*`,
	].join('\n');
}
