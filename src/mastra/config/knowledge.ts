import fs from "node:fs/promises";
import path from "node:path";
import { openai } from "@ai-sdk/openai";
import { PgVector } from "@mastra/pg";
import { MDocument } from "@mastra/rag";
import { embedMany } from "ai";

// Ensure environment variables are loaded
// Consider using a library like dotenv if not running in a framework context
import "dotenv/config";

console.log("Connecting to vector store...");

if (process.env.POSTGRES_CONNECTION_STRING) {
	console.error(
		"POSTGRES_CONNECTION_STRING environment variable is not set. Aborting.",
	);
}

const vectorStore = new PgVector({
	connectionString: process.env.POSTGRES_CONNECTION_STRING || "",
});

interface ChunkWithMetadata {
	text: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MDocument metadata is typed as Record<string, any>
	metadata: Record<string, unknown> & { sourceFile: string; text: string };
}

// Removed KNOWLEDGE_DIR constant
// Removed VECTOR_STORE_INDEX_NAME constant
const EMBEDDING_MODEL = openai.embedding("text-embedding-3-small"); // Or your preferred model
const VECTOR_DIMENSION = 1536; // Match your embedding model's dimension

async function readMarkdownFiles(
	dir: string,
): Promise<{ filePath: string; content: string }[]> {
	const absoluteDir = path.resolve(dir); // Ensure we use absolute path
	console.log(`Reading markdown files from: ${absoluteDir}`); // Add logging for clarity
	const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.resolve(absoluteDir, entry.name);
			if (entry.isDirectory()) {
				// Ensure recursive calls use the resolved path
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

export async function ingestKnowledge(
	knowledgeDir: string,
	vectorStoreIndexName: string,
): Promise<void> {
	console.log(
		`Starting knowledge ingestion for index '${vectorStoreIndexName}' from '${knowledgeDir}'...`,
	);
	const markdownFiles = await readMarkdownFiles(knowledgeDir); // Use parameter
	let allChunks: ChunkWithMetadata[] = [];

	console.log(`Found ${markdownFiles.length} markdown files. Processing...`);

	for (const file of markdownFiles) {
		console.log(`Processing: ${file.filePath}`);
		// Pass metadata including the source file path directly
		const doc = MDocument.fromMarkdown(file.content, {
			sourceFile: file.filePath,
		});

		// Chunking strategy remains the same
		await doc.chunk({
			strategy: "markdown",
			size: 1024, // Consider making these configurable too?
			overlap: 100, // Consider making these configurable too?
		});

		// Use getDocs() and ensure metadata includes sourceFile and original text
		const processedChunks: ChunkWithMetadata[] = doc.getDocs().map((chunk) => ({
			text: chunk.text,
			metadata: {
				...chunk.metadata, // Keep existing metadata
				text: chunk.text, // Store original text
				sourceFile: file.filePath, // Explicitly add sourceFile
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

	try {
		// await vectorStore.deleteIndex(vectorStoreIndexName); // Uncomment to clear before ingest
		await vectorStore.createIndex({
			indexName: vectorStoreIndexName, // Use parameter
			dimension: VECTOR_DIMENSION,
		});
		console.log(
			`Index '${vectorStoreIndexName}' created or already exists.`, // Use parameter
		);
	} catch (error: unknown) {
		if (error instanceof Error && error.message.includes("already exists")) {
			console.log(`Index '${vectorStoreIndexName}' already exists.`); // Use parameter
		} else {
			console.error("Error creating index:", error);
			return;
		}
	}

	console.log("Upserting embeddings and metadata...");
	try {
		await vectorStore.upsert({
			indexName: vectorStoreIndexName, // Use parameter
			vectors: embeddings,
			metadata: allChunks.map((chunk) => chunk.metadata),
		});
		console.log("Ingestion complete!");
	} catch (error) {
		console.error("Error upserting data:", error);
	}
}

(async () => {
	await vectorStore.deleteIndex("general_knowledge");
	await ingestKnowledge(
		path.resolve(__dirname, "../../knowledge/general"),
		"general_knowledge",
	);
	await vectorStore.deleteIndex("property_knowledge");
	await ingestKnowledge(
		path.resolve(__dirname, "../../knowledge/genie_properties"),
		"property_knowledge",
	);
	await vectorStore.disconnect?.();
})();
