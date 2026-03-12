declare module "bun:test" {
	export const after: (fn: () => void | Promise<void>) => void;
	export const afterAll: (fn: () => void | Promise<void>) => void;
	export const afterEach: (fn: () => void | Promise<void>) => void;
	export const before: (fn: () => void | Promise<void>) => void;
	export const beforeAll: (fn: () => void | Promise<void>) => void;
	export const beforeEach: (fn: () => void | Promise<void>) => void;
	export const describe: ((label: string, fn: () => void) => void) & {
		skip: (label: string, fn: () => void) => void;
	};
	export const expect: unknown;
	export const it: (
		label: string,
		fn:
			| ((...args: unknown[]) => void | Promise<void>)
			| ((done: (error?: unknown) => void) => void),
	) => void;
	export const jest: unknown;
	export const mock: {
		restore(): void;
	};
	export const spyOn: <T extends object, K extends keyof T>(
		target: T,
		methodName: K,
	) => {
		mockImplementation(implementation: (...args: never[]) => unknown): unknown;
	};
	export const test: (
		label: string,
		fn:
			| ((...args: unknown[]) => void | Promise<void>)
			| ((done: (error?: unknown) => void) => void),
	) => void;
}
