import { CONFIG_FLAG, LONG_CONFIG_FLAG } from '../cli/constants.js';

export const MODEL_INSTRUCTIONS_FILE_KEY = 'model_instructions_file';

export function isModelInstructionsOverride(value: string): boolean {
  return new RegExp(`^${MODEL_INSTRUCTIONS_FILE_KEY}\\s*=`).test(value.trim());
}

export function hasModelInstructionsOverride(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === CONFIG_FLAG || arg === LONG_CONFIG_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && isModelInstructionsOverride(maybeValue)) {
        return true;
      }
      continue;
    }

    if (arg.startsWith(`${LONG_CONFIG_FLAG}=`)) {
      const inlineValue = arg.slice(`${LONG_CONFIG_FLAG}=`.length);
      if (isModelInstructionsOverride(inlineValue)) return true;
    }
  }
  return false;
}
