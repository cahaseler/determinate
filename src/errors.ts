export class ValidationError extends Error {
	override name = "ValidationError" as const;
}

export class BudgetExceededError extends Error {
	override name = "BudgetExceededError" as const;
	constructor(
		public readonly section: string,
		public readonly actual: number,
		public readonly budget: number,
	) {
		super(`Token budget exceeded for "${section}": ${actual} tokens used, budget is ${budget}`);
	}
}

export class NoValidToolsError extends Error {
	override name = "NoValidToolsError" as const;
	constructor() {
		super("No tools passed their validWhen predicate for the current state");
	}
}

export class ProviderError extends Error {
	override name = "ProviderError" as const;
	constructor(
		public readonly provider: string,
		message: string,
	) {
		super(`[${provider}] ${message}`);
	}
}

export class OutputError extends Error {
	override name = "OutputError" as const;
	constructor(
		message: string,
		public readonly rawOutput: string,
	) {
		super(message);
	}
}

export class AbortError extends Error {
	override name = "AbortError" as const;
	constructor(message: string = "Operation was aborted") {
		super(message);
	}
}
