import fs from "node:fs/promises";
import path from "node:path";
import { openai } from "@ai-sdk/openai";
import { PgVector } from "@mastra/pg";
import { MDocument } from "@mastra/rag";
import { embedMany } from "ai";

// Ensure environment variables are loaded
// Consider using a library like dotenv if not running in a framework context
import "dotenv/config";

interface ChunkWithMetadata {
	text: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MDocument metadata is typed as Record<string, any>
	metadata: Record<string, unknown> & { sourceFile: string; text: string };
}

const KNOWLEDGE_DIR = path.resolve(__dirname, "../../knowledge/general"); // Adjust path
const VECTOR_STORE_INDEX_NAME = "general_knowledge";
const EMBEDDING_MODEL = openai.embedding("text-embedding-3-small"); // Or your preferred model
const VECTOR_DIMENSION = 1536; // Match your embedding model's dimension

async function readMarkdownFiles(
	dir: string,
): Promise<{ filePath: string; content: string }[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.resolve(dir, entry.name);
			if (entry.isDirectory()) {
				return readMarkdownFiles(fullPath);
			}
			if (entry.isFile() && entry.name.endsWith(".md")) {
				const content = await fs.readFile(fullPath, "utf-8");
				return [{ filePath: fullPath, content }];
			}
			return [];
		}),
	);
	return files.flat();
}

export async function ingestKnowledge(): Promise<void> {
	console.log("Starting knowledge ingestion...");
	const markdownFiles = await readMarkdownFiles(KNOWLEDGE_DIR);
	let allChunks: ChunkWithMetadata[] = [];

	console.log(`Found ${markdownFiles.length} markdown files. Processing...`);

	for (const file of markdownFiles) {
		console.log(`Processing: ${file.filePath}`);
		const doc = MDocument.fromMarkdown(file.content, { source: file.filePath });

		const chunks = await doc.chunk({
			strategy: "markdown",
			size: 512,
			overlap: 50,
		});

		const processedChunks: ChunkWithMetadata[] = doc.getDocs().map((chunk) => ({
			text: chunk.text,
			metadata: {
				...chunk.metadata,
				text: chunk.text, // Store original text
				sourceFile: file.filePath, // Ensure source is tracked
			},
		}));

		allChunks = allChunks.concat(processedChunks);
	}

	console.log(`Total chunks created: ${allChunks.length}`);
	if (allChunks.length === 0) {
		console.log("No chunks to process. Exiting.");
		return;
	}

	console.log("Generating embeddings...");
	const { embeddings } = await embedMany({
		model: EMBEDDING_MODEL,
		values: allChunks.map((chunk) => chunk.text),
	});
	console.log(`Generated ${embeddings.length} embeddings.`);

	if (embeddings.length !== allChunks.length) {
		console.error(
			"Mismatch between number of chunks and embeddings. Aborting.",
		);
		return;
	}

	console.log("Connecting to vector store...");
	const connectionString = process.env.POSTGRES_CONNECTION_STRING;
	if (!connectionString) {
		console.error(
			"POSTGRES_CONNECTION_STRING environment variable is not set. Aborting.",
		);
		return;
	}
	const vectorStore = new PgVector(connectionString);

	try {
		// await vectorStore.deleteIndex(VECTOR_STORE_INDEX_NAME); // Uncomment to clear before ingest
		await vectorStore.createIndex({
			indexName: VECTOR_STORE_INDEX_NAME,
			dimension: VECTOR_DIMENSION,
		});
		console.log(
			`Index '${VECTOR_STORE_INDEX_NAME}' created or already exists.`,
		);
	} catch (error: unknown) {
		if (error instanceof Error && error.message.includes("already exists")) {
			console.log(`Index '${VECTOR_STORE_INDEX_NAME}' already exists.`);
		} else {
			console.error("Error creating index:", error);
			await vectorStore.disconnect?.();
			return;
		}
	}

	console.log("Upserting embeddings and metadata...");
	try {
		await vectorStore.upsert({
			indexName: VECTOR_STORE_INDEX_NAME,
			vectors: embeddings,
			metadata: allChunks.map((chunk) => chunk.metadata),
		});
		console.log("Ingestion complete!");
	} catch (error) {
		console.error("Error upserting data:", error);
	} finally {
		await vectorStore.disconnect?.();
		console.log("Vector store disconnected.");
	}
}

ingestKnowledge().catch((error) => {
	console.error("Unhandled error during ingestion:", error);
	process.exit(1);
});
