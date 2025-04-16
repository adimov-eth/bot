import { createLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
import { PgVector } from "@mastra/pg";
import dotenv from "dotenv";
import { realEstateAgent } from "./agents";
// Knowledge ingestion should be run as a separate script before starting the app
// import { ingestKnowledge } from "./config/knowledge";
dotenv.config();
// ingestKnowledge();
// Define the vector store for the knowledge base
const knowledgeVectorStore = new PgVector({
	connectionString: process.env.POSTGRES_CONNECTION_STRING || "",
});

export const mastra = new Mastra({
	agents: { realEstateAgent },
	vectors: {
		general_knowledge: knowledgeVectorStore,
	},
	logger: createLogger({
		name: "Mastra",
		level: "info",
	}),
});

// Removed the initializeApp function and the direct call to ingestKnowledge
