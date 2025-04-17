import { createLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
import { PgVector } from "@mastra/pg";
import dotenv from "dotenv";
import { realEstateAgent, sqlAgent } from "./agents";
import { TelegramIntegration } from "./integrations/telegram"; // Import the class, not an instance
// Knowledge ingestion should be run as a separate script before starting the app
// import { ingestKnowledge } from "./config/knowledge";
dotenv.config();
// ingestKnowledge();
// Define the vector store for the knowledge base
const knowledgeVectorStore = new PgVector({
	connectionString: process.env.POSTGRES_CONNECTION_STRING || "",
});

export const mastra = new Mastra({
	agents: { realEstateAgent, sqlAgent },
	vectors: {
		general_knowledge: knowledgeVectorStore,
	},
	logger: createLogger({
		name: "Mastra",
		level: "info",
	}),
});

// Create and export a single TelegramIntegration instance
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
	console.error("TELEGRAM_BOT_TOKEN is not set in environment variables");
	process.exit(1);
}

// Initialize Telegram bot
const telegramBot = new TelegramIntegration(TELEGRAM_BOT_TOKEN);
export { telegramBot };

// Set up signal handlers for graceful shutdown
const gracefulShutdown = async (signal: string) => {
	console.log(`Received ${signal}. Shutting down gracefully...`);

	// First stop the Telegram bot
	await telegramBot.stop();

	// Then other cleanup
	console.log("Shutdown complete. Exiting...");
	setTimeout(() => process.exit(0), 500); // Allow 500ms for cleanup
};

// Listen for termination signals
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
