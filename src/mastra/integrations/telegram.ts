import process from "node:process";
import TelegramBot from "node-telegram-bot-api";
import { realEstateAgent } from "../agents";

// Helper to check if an object is likely a plain object
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Allow any for generic check
const isPlainObject = (obj: unknown): obj is Record<string, unknown> =>
	Object.prototype.toString.call(obj) === "[object Object]";

/**
 * A thin wrapper around node‑telegram‑bot‑api that hides the agent's streaming
 * interface from the end‑user.  From the user's perspective the bot now behaves
 * like a real person: they only see the "typing…" indicator while the assistant
 * thinks and then receive one (or several, if 4 096‑char limit is exceeded)
 * full messages.
 */
export class TelegramIntegration {
	private bot: TelegramBot;
	private readonly MAX_MESSAGE_LENGTH = 4096; // Telegram hard limit

	constructor(token: string) {
		this.bot = new TelegramBot(token, {
			polling: {
				interval: 500,
				params: { timeout: 10 },
			},
		});

		this.bot.on("message", (msg) =>
			this.handleMessage(msg).catch(console.error),
		);
		this.bot.on("polling_error", (err) => console.error("Polling error", err));

		// Small connectivity self‑check
		this.bot
			.getMe()
			.then((me) => console.log(`✅ Connected to Telegram as @${me.username}`));

		// Ensure we are in polling mode
		this.bot.deleteWebHook().catch(() => void 0);

		// Graceful shutdown signals
		process.once("SIGINT", () => this.stop());
		process.once("SIGTERM", () => this.stop());
	}

	public async stop(): Promise<void> {
		try {
			await this.bot.stopPolling({ cancel: true });
			console.log("Telegram bot stopped gracefully");
		} catch (e) {
			console.error("Error while stopping bot", e);
		}
	}

	//—————————————— helpers ——————————————

	/** Truncate very long strings so we never exceed limits. */
	private truncate(str: string, max = 1_000): string {
		return str.length > max ? `${str.slice(0, max - 15)}… [truncated]` : str;
	}

	/** Split a long message into <= 4 096‑char chunks. */
	private chunkMessage(text: string): string[] {
		const chunks: string[] = [];
		for (let i = 0; i < text.length; i += this.MAX_MESSAGE_LENGTH) {
			chunks.push(text.slice(i, i + this.MAX_MESSAGE_LENGTH));
		}
		return chunks;
	}

	/** Format a tool result as plain text */
	private formatToolResult(result: unknown): string {
		if (
			isPlainObject(result) &&
			"error" in result &&
			typeof result.error === "string"
		) {
			return `Error: ${String(result.error)}`;
		}

		if (Array.isArray(result) && result.length && result.every(isPlainObject)) {
			const headers = Object.keys(result[0]).slice(0, 5);
			const headerLine = headers.join(" | ");
			const separator = headers.map(() => "---").join(" | ");
			const rows = result
				.slice(0, 10)
				.map((row) =>
					headers
						.map((h) => this.truncate(String(row[h] ?? ""), 30))
						.join(" | "),
				)
				.join("\n");
			return `${headerLine}\n${separator}\n${rows}`;
		}

		return this.truncate(JSON.stringify(result, null, 2), 1_000);
	}

	/** Continuously sends "typing" action every 3 s until the returned fn is called. */
	private startTyping(chatId: number): () => void {
		this.bot.sendChatAction(chatId, "typing").catch(() => void 0);
		const int = setInterval(
			() => this.bot.sendChatAction(chatId, "typing").catch(() => void 0),
			3000,
		);
		return () => clearInterval(int);
	}

	//—————————————— main handler ——————————————

	private async handleMessage(msg: TelegramBot.Message): Promise<void> {
		const chatId = msg.chat.id;
		const text = msg.text ?? "";
		const userName = msg.from?.first_name ?? "there";
		const userId = msg.from?.id
			? `telegram-${msg.from.id}`
			: `telegram-${chatId}`; // Consistent user ID

		// Commands -----------------------------------------------------------
		// if (text.startsWith("/")) {
		// 	const command = text.split(" ")[0];
		// 	if (command === "/start") {
		// 		await this.bot.sendMessage(
		// 			chatId,
		// 			`Hello, ${userName}! How can I help you with luxury real estate in Dubai today?`,
		// 		);
		// 		return;
		// 	}
		// 	if (command === "/reset") {
		// 		await this.bot.sendMessage(
		// 			chatId,
		// 			"Context cleared. What would you like to discuss next?",
		// 		);
		// 		return;
		// 	}
		// 	await this.bot.sendMessage(chatId, `Unknown command ${command}`);
		// 	return;
		// }

		// Regular text -------------------------------------------------------
		const stopTyping = this.startTyping(chatId);
		const response = "";

		try {
			// We still leverage the stream API, but buffer everything locally
			const message = await realEstateAgent.generate(text, {
				threadId: `telegram3-${chatId}`, // Use chat ID for thread
				resourceId: userId, // Use defined userId
				// Pass additional context, including the chatId
				context: [
					{
						role: "system",
						content: `
							chatId: ${chatId}, 
							userName: ${userName}
						`,
					},
				],
				// No system context message about user name to prevent it showing up in responses
			});

			// // Response should already be clean from the agent/tool
			// response = response.trim() || "¯\\_(ツ)_/¯";
			stopTyping();
			const messages = this.chunkMessage(message.text ?? "");
			// const parse_mode = "Markdown";
			for (const part of messages) {
				// Send plain text without parse_mode
				await this.bot.sendMessage(chatId, part);
			}
		} catch (e) {
			stopTyping();
			await this.bot.sendMessage(
				chatId,
				"Sorry, an error occurred. Please try again later.",
			);
			console.error("Agent error", e);
		}
	}
}
