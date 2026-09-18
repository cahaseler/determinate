import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { OutputError, ProviderError, ValidationError } from "../../src/errors";
import { createDecider, DeciderUnavailableError } from "../../src/index";

type Body = Record<string, unknown>;

const answer = (choice: string, confidence = 0.9) => ({
	type: "choice",
	choice,
	confidence,
	probabilities: { [choice]: confidence },
});

describe("createDecider", () => {
	let server: ReturnType<typeof Bun.serve>;
	let requests: Array<{ authorization: string | null; body: Body }>;
	let respond: (body: Body) => Response;

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const body = (await req.json()) as Body;
				requests.push({ authorization: req.headers.get("authorization"), body });
				return respond(body);
			},
		});
	});
	afterAll(() => server.stop());
	beforeEach(() => {
		requests = [];
		respond = () => Response.json({ model: "jev-test", answers: {}, usage: {} });
	});

	const decider = (pricing?: { input: number; output: number }) =>
		createDecider({
			type: "typesafe",
			apiKey: "key-1",
			baseUrl: `http://localhost:${server.port}`,
			pricing,
		});

	it("asks several closed questions about one state and reads each answer", async () => {
		respond = () =>
			Response.json({
				model: "jev-test",
				answers: { triage: answer("now", 0.85), reply: answer("yes", 0.7) },
				usage: { input_tokens: 120, output_tokens: 0 },
			});

		const result = await decider({ input: 0.042, output: 0 }).ask({
			state: { message: { from: "Marek", text: "at 4 fuel, can you bring a cell?" } },
			questions: {
				triage: {
					question: "How should this message be handled?",
					options: { now: "Deal with it now", later: "In the evening digest", trash: "Ignore it" },
				},
				reply: { question: "Reply?", options: { yes: null, no: null } },
			},
		});

		expect(result.answers.triage).toEqual({
			choice: "now",
			confidence: 0.85,
			probabilities: { now: 0.85 },
		});
		expect(result.answers.reply.choice).toBe("yes");
		expect(result.meta).toMatchObject({ model: "jev-test", tokensUsed: { input: 120, output: 0 } });
		expect(result.meta.cost).toBeCloseTo(120 * 0.042e-6);
		expect(requests[0]?.authorization).toBe("Bearer key-1");
		expect(requests[0]?.body).toEqual({
			state: { message: { from: "Marek", text: "at 4 fuel, can you bring a cell?" } },
			model: "jev-latest",
			questions: {
				triage: {
					type: "choice",
					instructions: "How should this message be handled?",
					criteria: { now: "Deal with it now", later: "In the evening digest", trash: "Ignore it" },
				},
				reply: { type: "choice", instructions: "Reply?", criteria: { yes: null, no: null } },
			},
		});
	});

	it("reaches Jev through OpenRouter's decisions endpoint with the same body, and takes the cost it reports", async () => {
		let path = "";
		const routed = Bun.serve({
			port: 0,
			fetch: async (req) => {
				path = new URL(req.url).pathname;
				requests.push({
					authorization: req.headers.get("authorization"),
					body: (await req.json()) as Body,
				});
				return Response.json({
					model: "typesafe/jev-1.13-20260917",
					answers: { choice: answer("a", 0.9) },
					usage: { input_tokens: 371, output_tokens: 39, cost: 0.000015582 },
					id: "gen-dec-1",
					provider: "TypeSafe",
				});
			},
		});
		try {
			const picked = await createDecider({
				type: "openrouter",
				apiKey: "or-key",
				baseUrl: `http://localhost:${routed.port}`,
			}).choose({ state: { x: 1 }, question: "Which?", options: { a: null, b: null } });

			expect(path).toBe("/api/alpha/decisions");
			expect(requests[0]?.authorization).toBe("Bearer or-key");
			expect(requests[0]?.body).toMatchObject({ model: "typesafe/jev-1.13", state: { x: 1 } });
			expect(picked).toMatchObject({ choice: "a", confidence: 0.9 });
			expect(picked.meta.model).toBe("typesafe/jev-1.13-20260917");
			expect(picked.meta.cost).toBeCloseTo(0.000015582);
		} finally {
			routed.stop();
		}
	});

	it("choose asks one question and returns its answer with the meta", async () => {
		respond = () =>
			Response.json({ model: "jev-test", answers: { choice: answer("b", 0.6) }, usage: {} });

		const picked = await decider().choose({
			state: {},
			question: "Which?",
			options: { a: null, b: null },
		});

		expect(picked).toMatchObject({ choice: "b", confidence: 0.6, meta: { model: "jev-test" } });
		expect(picked.meta.cost).toBeUndefined();
	});

	it("rejects a question with too few or too many options before asking", async () => {
		await expect(
			decider().choose({ state: {}, question: "Which?", options: { only: null } }),
		).rejects.toBeInstanceOf(ValidationError);
		const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
		await expect(
			decider().choose({ state: {}, question: "Which?", options: many }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(requests).toHaveLength(0);
	});

	it("throws OutputError when an answer is not one of the options", async () => {
		respond = () =>
			Response.json({ model: "jev-test", answers: { choice: answer("c") }, usage: {} });
		await expect(
			decider().choose({ state: {}, question: "Which?", options: { a: null, b: null } }),
		).rejects.toBeInstanceOf(OutputError);
	});

	it("throws ProviderError on a rejected request and DeciderUnavailableError when the service keeps failing", async () => {
		respond = () => new Response("bad key", { status: 401 });
		await expect(
			decider().choose({ state: {}, question: "Which?", options: { a: null, b: null } }),
		).rejects.toBeInstanceOf(ProviderError);

		respond = () => new Response("overloaded", { status: 529 });
		await expect(
			decider().choose({ state: {}, question: "Which?", options: { a: null, b: null } }),
		).rejects.toBeInstanceOf(DeciderUnavailableError);
	});
});
