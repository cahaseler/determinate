import type { z } from "zod";

/**
 * Zod's message for a failed union is "Invalid input", which tells a model nothing about what
 * would have passed. A union of literals is how a tool offers a closed set of options, so the
 * correction names those options; other issues keep Zod's own message, prefixed with the path.
 */
export function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
	return issues.map(describeIssue).join("; ");
}

function describeIssue(issue: z.core.$ZodIssue): string {
	const where = issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
	if (issue.code !== "invalid_union") return `${where}${issue.message}`;
	const branches = issue.errors.flat();
	const expected = [
		...branches.flatMap((branch) =>
			branch.code === "invalid_value" ? branch.values.map((value) => JSON.stringify(value)) : [],
		),
		...branches.flatMap((branch) =>
			branch.code === "invalid_type" ? [`a ${branch.expected}`] : [],
		),
	];
	return expected.length > 0
		? `${where}expected one of ${expected.join(", ")}`
		: `${where}${branches.map((branch) => branch.message).join(" or ")}`;
}
