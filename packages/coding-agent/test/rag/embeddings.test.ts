import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { getRagEmbedder, setRagEmbedderForTests, type RagEmbedder } from "../../src/rag/embeddings";

const savedApiUrlEnv = Bun.env.MNEMOPI_EMBEDDING_API_URL;

afterEach(() => {
	setRagEmbedderForTests(undefined);
	if (savedApiUrlEnv === undefined) delete Bun.env.MNEMOPI_EMBEDDING_API_URL;
	else Bun.env.MNEMOPI_EMBEDDING_API_URL = savedApiUrlEnv;
});

/** Deterministic test embedder: vector[i] = (charCodeSum + i) % 7 / 7. */
function fakeEmbedder(dim = 8): RagEmbedder {
	return {
		model: "fake-model",
		dim,
		async embed(texts) {
			return texts.map(text => {
				const vector = new Float32Array(dim);
				let sum = 0;
				for (const ch of text) sum += ch.charCodeAt(0);
				for (let i = 0; i < dim; i += 1) vector[i] = ((sum + i) % 7) / 7;
				return vector;
			});
		},
	};
}

describe("rag embedder resolution", () => {
	it("returns the injected test embedder as-is", async () => {
		const fake = fakeEmbedder();
		setRagEmbedderForTests(fake);
		expect(await getRagEmbedder()).toBe(fake);
		const vectors = await fake.embed(["hello"]);
		expect(vectors).toHaveLength(1);
		expect(vectors[0]).toHaveLength(8);
	});

	it("an injected null forces unavailability", async () => {
		setRagEmbedderForTests(null);
		expect(await getRagEmbedder()).toBeNull();
	});

	it("returns null when RAG is disabled or the mode is off", async () => {
		const disabled = Settings.isolated({ "web_search.rag.enabled": false });
		expect(await getRagEmbedder(disabled)).toBeNull();
		const off = Settings.isolated({ "web_search.rag.embedding": "off" });
		expect(await getRagEmbedder(off)).toBeNull();
	});

	it("api mode without any base URL is unavailable", async () => {
		delete Bun.env.MNEMOPI_EMBEDDING_API_URL;
		const api = Settings.isolated({ "web_search.rag.embedding": "api" });
		expect(await getRagEmbedder(api)).toBeNull();
	});

	it("api mode embeds via the OpenAI-compatible endpoint and corrects dim from the response", async () => {
		const savedFetch = globalThis.fetch;
		let requestedUrl = "";
		try {
			globalThis.fetch = (async (input: string | URL | Request) => {
				requestedUrl = String(input);
				return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }] }), {
					status: 200,
				});
			}) as typeof fetch;
			const scope = Settings.isolated({
				"web_search.rag.embedding": "api",
				"web_search.rag.embeddingApiUrl": "http://127.0.0.1:9/v1",
			});
			const embedder = await getRagEmbedder(scope);
			expect(embedder).not.toBeNull();
			expect(embedder!.model).toBe("text-embedding-3-small");
			const vectors = await embedder!.embed(["a", "b"]);
			expect(requestedUrl).toBe("http://127.0.0.1:9/v1/embeddings");
			expect(vectors).toHaveLength(2);
			expect([...vectors[0]!]).toEqual([1, 2, 3]);
			expect(embedder!.dim).toBe(3);
		} finally {
			globalThis.fetch = savedFetch;
		}
	});

	it("api mode surfaces HTTP failures as thrown errors", async () => {
		const savedFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
			const scope = Settings.isolated({
				"web_search.rag.embedding": "api",
				"web_search.rag.embeddingApiUrl": "http://127.0.0.1:9/v1",
			});
			const embedder = await getRagEmbedder(scope);
			expect(embedder).not.toBeNull();
			await expect(embedder!.embed(["a"])).rejects.toThrow(/500/);
		} finally {
			globalThis.fetch = savedFetch;
		}
	});
});
