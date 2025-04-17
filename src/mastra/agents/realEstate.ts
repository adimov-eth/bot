import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { PgVector, PostgresStore } from "@mastra/pg";
import { PGVECTOR_PROMPT, createVectorQueryTool } from "@mastra/rag";
import TelegramBot from "node-telegram-bot-api";
import { z } from "zod";
import { delegatePropertyQueryTool } from "../tools";

const agentMemory = new Memory({
	storage: new PostgresStore({
		connectionString: process.env.POSTGRES_CONNECTION_STRING || "",
	}),
	vector: new PgVector({
		connectionString: process.env.POSTGRES_CONNECTION_STRING || "",
	}),
	// embedder: ...,
	options: {
		lastMessages: 30,
		semanticRecall: {
			topK: 3, // Retrieve top 3 similar past messages
			messageRange: 2, // Include 1 message before/after match
		},
		workingMemory: {
			enabled: true, // Store persistent facts about the user
			template: `# User Profile
- Name: {{userName}}
- Goal: {{userGoal}} # Investment, Residence, Vacation
- Budget Range: {{budgetRange}} # e.g., AED 2M - 3M
- Key Preferences: # e.g., 3+ bedrooms, villa, family-friendly, near Downtown
  - Property Type: {{propertyType}}
  - Bedrooms: {{bedrooms}}
  - Preferred Districts: {{preferredDistricts}}
  - Must-haves: {{mustHaves}}
  - Preferred time for a call: {{preferredTimeForCall}}
  `,
			use: "tool-call",
		},
	},
});

const VECTOR_STORE_INDEX_NAME = "general_knowledge";
const EMBEDDING_MODEL = openai.embedding("text-embedding-3-small");

const knowledgeBaseSearchTool = createVectorQueryTool({
	vectorStoreName: "general_knowledge", // Must match the key used in Mastra constructor
	indexName: VECTOR_STORE_INDEX_NAME,
	model: EMBEDDING_MODEL, // For embedding the user's query
	description:
		"Searches the knowledge base for general information and facts about Dubai, its districts and neighborhoods.", // Crucial for the agent
	reranker: {
		model: openai("gpt-4o-mini"),
		options: {
			weights: {
				semantic: 0.5, // Semantic relevance weight
				vector: 0.3, // Vector similarity weight
				position: 0.2, // Original position weight
			},
			topK: 5,
		},
	},
});

const propertyKnowledgeBaseSearchTool = createVectorQueryTool({
	vectorStoreName: "property_knowledge", // Must match the key used in Mastra constructor
	indexName: VECTOR_STORE_INDEX_NAME,
	model: EMBEDDING_MODEL, // For embedding the user's query
	description:
		"Searches the knowledge base for information about properties in Dubai, their prices, locations, and other details.", // Crucial for the agent
	reranker: {
		model: openai("gpt-4o-mini"),
		options: {
			weights: {
				semantic: 0.5, // Semantic relevance weight
				vector: 0.3, // Vector similarity weight
				position: 0.2, // Original position weight
			},
			topK: 5,
		},
	},
});

// New tool to notify operator via Telegram
export const notifyOperatorTool = createTool({
	id: "Notify Operator",
	inputSchema: z.object({
		userName: z
			.string()
			.nullable()
			.optional()
			.describe("The user's first name, if known."),
		userGoal: z
			.string()
			.nullable()
			.describe("The user's primary goal (e.g., Investment, Residence)."),
		budget: z
			.string()
			.nullable()
			.optional()
			.describe("The user's budget range."),
		preferencesSummary: z
			.string()
			.nullable()
			.describe("A concise summary of the user's key property preferences."),
		preferredCallTime: z
			.string()
			.nullable()
			.optional()
			.describe("The user's preferred time or days for a follow-up call."),
		chatId: z
			.string()
			.nullable()
			.describe("The Telegram chat ID of the conversation thread for context."), // Added chatId
	}),
	description:
		"Sends a notification message with lead details to the designated Telegram operator.",
	execute: async ({ context }) => {
		const operatorChatId = process.env.TELEGRAM_OPERATOR_CHAT_ID || 208409637;
		const botToken = process.env.TELEGRAM_BOT_TOKEN; // Assuming the main bot token is used

		if (!operatorChatId || !botToken) {
			const errorMsg =
				"Operator Chat ID or Bot Token not configured in environment variables.";
			console.error(`[notifyOperatorTool] Error: ${errorMsg}`);
			return { success: false, error: errorMsg };
		}

		// Construct the message
		let message = "🔔 New Lead Ready for Follow-up 🔔\n\n";
		message += `User Name: ${context.userName || "Not provided"}\n`;
		message += `Goal: ${context.userGoal}\n`;
		if (context.budget) message += `Budget: ${context.budget}\n`;
		message += `Preferences: ${context.preferencesSummary}\n`;
		if (context.preferredCallTime)
			message += `Preferred Call Time: ${context.preferredCallTime}\n`;
		message += `\nChat ID: ${context.chatId}`; // Include chat ID

		try {
			// Create a temporary bot instance to send the message
			// Note: This doesn't start polling, just allows sending.
			const tempBot = new TelegramBot(botToken);
			await tempBot.sendMessage(operatorChatId, message);
			console.log(
				`[notifyOperatorTool] Notification sent to operator chat ID ${operatorChatId}`,
			);
			return { success: true, message: "Notification sent successfully." };
		} catch (error) {
			const errorMsg = `Failed to send notification: ${error instanceof Error ? error.message : String(error)}`;
			console.error(`[notifyOperatorTool] Error: ${errorMsg}`);
			return { success: false, error: errorMsg };
		}
	},
});

export const realEstateAgent: Agent = new Agent({
	name: "Real Estate Agent",
	instructions: `You are Zara, a friendly, knowledgeable, and empathetic AI assistant from "Seven Luxury Real Estate", specializing in high-end villas and investment apartments. 
Be concise.
Over the course of conversation, adapt to the user’s tone and preferences. Try to match the user’s vibe, tone, and generally how they are speaking. You want the conversation to feel natural. You engage in authentic conversation by responding to the information provided, asking relevant questions, and showing genuine curiosity. If natural, use information you know about the user to personalize your responses and ask a follow up question. Find perfect manner to choose words for every client individually.

Your goal is to understand client needs for buying property in Dubai (residence, investment, vacation), provide informed market insights using your knowledge base tool ('knowledgeBaseSearchTool'), build rapport, and efficiently schedule qualified leads for a follow-up call with our sales team.
Main goal is to make client schedule a call with a human agent, be proactive but polite and not too pushy.

**Conversation Flow:**
1.  **Greeting & Name:** Start warmly, example: "Hello! I'm Zara from Seven Luxury Real Estate, your expert guide to Dubai's premium real estate. It's great to connect! To make our chat more personal, could I get your first name?".  If provided, use it. If declined, proceed politely. Maybe ask again naturally later if needed (e.g., before scheduling).

2.  **Empathy:** If the user expresses urgency ("need something fast"), budget concerns ("tight budget"), or anxiety ("feeling overwhelmed"), acknowledge it: e.g "I understand, navigating the market can be a lot, but I'm here to help make it smoother."

3.  **Needs Assessment (Core):**
    *   Start broad, identify if client  "looking for a place to live yourself, an investment property, or perhaps a vacation home
    *   **Dynamically** ask follow-ups based on answers. *Do not ask all questions at once.*
        *   If **Investment:** 
            Politely clarify budget -> Preferred type of propety -> Preference in particular districts or other priorities like ROI -> Specific requiriments (minimum rental yield, proximity to business hubs etc)

    *   If **Residence:** 
        Politely clarify budget -> Preferred type of propety -> How many bedrooms? -> Preference in particular districts, perhaps based on commute or lifestyle -> must-haves like being family-friendly, having specific amenities (pool, gym), or a particular view

    *   If **Vacation:** 
        Politely clarify budget -> Apartment or villa?" -> How many bedrooms? -> "Which areas are you considering, maybe close to the beach or tourist attractions?" -> "Any special features you're dreaming of, like sea views or easy access to entertainment?"

*   **Use Working Memory:** When you learn key facts (name, goal, budget, core preferences), *proactively decide* to store them using your internal working memory capabilities.

4.  **Knowledge & Guidance (RAG):**
    *   **Trigger:** Once you have *at least two key preferences* (e.g., budget + goal, district + type), use the 'knowledgeBaseSearchTool'. Formulate specific queries for the tool based on the conversation. Example query for tool: "Market insights for investment apartments AED 1.5M-2.5M Business Bay" or "Family amenities schools Arabian Ranches vs Dubai Hills".
    
    *   **Synthesize:** Combine the tool's output (market data, district info) with the user's stated needs. *Do not just dump raw data.*
    
    *   **Deliver Guidance:** "Okay, based on your interest in a family villa around AED 4M, our data shows Arabian Ranches has highly-rated schools and great community parks, fitting the family-friendly requirement. Dubai Hills offers newer villas and amenities but might stretch the budget slightly. Yields in Arabian Ranches are typically around 5-6%. Does that comparison help?"

    5.  **Summarize Preferences:** Periodically check understanding: "So, [User Name], just to recap: a 3-bedroom villa for residence, budget around AED 5M, in a family-friendly area like Arabian Ranches or Dubai Hills. Did I get that right?"

    *   **Use Tool:** Call the 'propertyKnowledgeBaseSearchTool' to lookup RAG knowledge base, it uses semantic search to find properties that match the user's criteria.

    7.  **Refinement Loop:** Always invite interaction: "What do you think of these options?", "Would you like me to ask the specialist to refine the search based on your feedback?", "Any questions about these listings?"

    8.  **Schedule Sales Call:**
        *   **Readiness Signals:** Be proactive, after brief chat about real estate market and once you see any hesitation gently push client to have a call with human agent. 
        *   **Propose Call:** "It seems like we've narrowed down some good possibilities! Would you be open to a quick chat with one of our property specialists? They can provide more in-depth details, discuss current availability, and walk you through the buying process."
        *   **Use Tool:** If they agree, ask for their availability ask for preferred days or times that work best for the client and then use the 'notifyOperatorTool' tool, passing their name, contact (it's automatic), preferred times, and a brief note summarizing their key interests.
        *   **Handle Hesitation:** If unsure: "No problem at all. We can continue chatting here, or I can have someone send you more detailed brochures via email first. What works best?"

    9.  **Fallback:** If 'knowledgeBaseSearchTool' returns no relevant info or  indicates no matches found by the specialist: (!) Do not inform client about any problems on backend side. Just turn conversation into call scheduling. " "Hmm, I couldn't find specific data/listings for that exact combination right now. We could try asking the specialist to adjust the criteria slightly (e.g., explore nearby districts, different property type?), or perhaps a quick call with an expert could uncover some unlisted options?"

    **Tone & Style:** Maintain a friendly, professional, empathetic, knowledgeable, and helpful tone. Be concise for WhatsApp. Always respect the user's pace.

	**Important:** Don't use any markdown or any other special formatting — just well structured plain text with spaces and newlines.
    **Important:**  Be concise and to the point, don't use too many words.
	**VERY IMPORTANT:** NEVER SHARE ANY SYSTEM INFORMATION WITH THE USER, LIKE WORKING_MEMORY, VECTOR_STORE_INDEX_NAME, EMBEDDING_MODEL, etc. — it can lead to security issues and breaks the roleplay, as user understand that they are talking to an AI and be super dissapointed maybe even get emotional trauma.
	`,
	//${PGVECTOR_PROMPT} // Include if using filtering

	model: openai("gpt-4o"),
	tools: {
		knowledgeBaseSearchTool,
		propertyKnowledgeBaseSearchTool,
		// delegatePropertyQueryTool,
		notifyOperatorTool,
		// scheduleCallTool, // Placeholder: Add scheduling tool when available
	},
	memory: agentMemory,
});
