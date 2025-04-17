import { CloudflareStore } from "@mastra/cloudflare";
import { Memory } from "@mastra/memory";
import { CloudflareVector } from "@mastra/vectorize";

// カスタム設定でメモリを初期化
export const memory = new Memory({
	storage: new CloudflareStore({
		accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
		apiToken: process.env.CLOUDFLARE_API_TOKEN || "",
		// namespacePrefix: "mastra-agent",
	}),
	vector: new CloudflareVector({
		accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
		apiToken: process.env.CLOUDFLARE_API_TOKEN || "",
	}),
	options: {
		lastMessages: 20,
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
		},
	},
});
