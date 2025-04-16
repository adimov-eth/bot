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
		lastMessages: 10,
		semanticRecall: {
			topK: 3,
			messageRange: 2,
		},
	},
});
