import process from "node:process"; // Import process for signal handling
import { Agent } from "@mastra/core/agent"; // Import Agent type if needed for memory reset
import TelegramBot from "node-telegram-bot-api";
import { realEstateAgent } from "../agents";

// Helper to check if an object is likely a plain object
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Allow any for generic check
const isPlainObject = (obj: unknown): obj is Record<string, unknown> =>
	Object.prototype.toString.call(obj) === "[object Object]";

export class TelegramIntegration {
	private bot: TelegramBot;
	private readonly MAX_MESSAGE_LENGTH = 4096; // Telegram's message length limit
	private readonly MAX_RESULT_ROWS = 10; // Max rows for table formatting
	private readonly MAX_RESULT_COLS = 5; // Max cols for table formatting
	private readonly MAX_COL_WIDTH = 30; // Max width for table columns
	private isShuttingDown = false; // Flag to prevent duplicate shutdown logic

	constructor(token: string) {
		console.log("Initializing TelegramIntegration..."); // Add log for debugging instantiation
		// Create a bot instance
		this.bot = new TelegramBot(token, {
			polling: {
				// Increase interval slightly during dev? Might help reduce immediate conflict on restart
				interval: 500, // milliseconds
				params: { timeout: 10 }, // Keep timeout reasonable
			},
		});

		// Handle incoming messages
		this.bot.on("message", (msg) => {
			console.log(`[${new Date().toISOString()}] Received message event.`); // LOG: Message event received
			// Ignore messages if shutting down
			if (this.isShuttingDown) {
				console.log("Shutdown in progress, ignoring incoming message.");
				return;
			}
			this.handleMessage(msg);
		});

		// Log polling errors for more details
		this.bot.on("polling_error", (error) => {
			// Avoid logging during shutdown if the error is expected
			if (!this.isShuttingDown) {
				// Log the full error object for more context
				console.error("Telegram Polling Error:", error);
			}
		});

		console.log("Telegram bot polling started...");

		// Add this near the constructor to test basic connectivity
		try {
			// Test if the bot token is valid by making a getMe request
			console.log(
				`[${new Date().toISOString()}] Testing Telegram bot token validity...`,
			);
			this.bot
				.getMe()
				.then((botInfo) => {
					console.log(
						`[${new Date().toISOString()}] ✅ Bot connection test successful! Connected as @${botInfo.username}`,
					);
				})
				.catch((error) => {
					console.error(
						`[${new Date().toISOString()}] ❌ Bot connection test failed:`,
						error,
					);
				});
		} catch (error) {
			console.error(
				`[${new Date().toISOString()}] ❌ Critical error during bot connection test:`,
				error,
			);
		}

		// Delete any existing webhook first to ensure polling works
		this.bot
			.deleteWebHook()
			.then(() => {
				console.log(
					`[${new Date().toISOString()}] Successfully cleared any existing webhooks.`,
				);
			})
			.catch((error) => {
				console.error(
					`[${new Date().toISOString()}] Error clearing webhooks:`,
					error,
				);
			});
	}

	// Method to gracefully stop the bot
	public async stop(): Promise<void> {
		if (this.isShuttingDown) {
			return; // Already shutting down
		}
		this.isShuttingDown = true;
		console.log("Stopping Telegram bot polling...");
		try {
			// Stop polling first
			await this.bot.stopPolling({ cancel: true }); // cancel pending getUpdates
			// Optional: close the underlying connection, might not be necessary with stopPolling
			// await this.bot.close();
			console.log("Telegram bot polling stopped.");
		} catch (error) {
			console.error("Error stopping Telegram bot:", error);
		}
	}

	private escapeMarkdownV2(
		text: string | number | boolean | null | undefined,
	): string {
		if (text === null || text === undefined) return "";
		// Escape special MarkdownV2 characters
		// '.', '-', '|', '{', '}' must also be escaped.
		return String(text).replace(/([_*[\]()~`>#+=|{}.!-])/g, "\\$1");
	}

	private truncateString(str: string, maxLength: number): string {
		if (str.length <= maxLength) return str;
		return `${str.substring(0, maxLength - 15)}... [truncated]`;
	}

	// Format results, attempting nice tables for arrays of objects
	private formatToolResult(result: unknown): string {
		// LOG: Formatting tool result
		console.log(`[${new Date().toISOString()}] Formatting tool result...`);
		try {
			// Handle specific error structure from delegatePropertyQueryTool
			if (
				isPlainObject(result) &&
				result.error &&
				typeof result.error === "string"
			) {
				// Escape the user-facing error message content
				return `❌ Error from tool: ${this.escapeMarkdownV2(result.error)}`;
			}

			// Try formatting as a Markdown table if it's an array of objects
			if (
				Array.isArray(result) &&
				result.length > 0 &&
				result.every(isPlainObject)
			) {
				// Slice headers *before* mapping to avoid unnecessary processing
				const headers = Object.keys(result[0]).slice(0, this.MAX_RESULT_COLS);

				// Escape headers for the header line
				const headerLine = headers
					.map((h) =>
						this.escapeMarkdownV2(this.truncateString(h, this.MAX_COL_WIDTH)),
					)
					.join(" | "); // Add spaces around the pipe for readability

				// Generate separator line based on the actual number of headers being shown
				const separatorLine = headers.map(() => "---").join(" | "); // Use --- for clarity

				// Process and escape data for rows, ensuring correct header mapping
				const rows = result
					.slice(0, this.MAX_RESULT_ROWS) // Limit rows *before* mapping
					.map((row) =>
						headers // Map using the sliced headers array
							.map((header) =>
								this.escapeMarkdownV2(
									this.truncateString(
										// Safely access property, default to empty string if missing
										String(row[header] ?? ""),
										this.MAX_COL_WIDTH,
									),
								),
							)
							.join(" | "),
					); // Add spaces around the pipe

				// Construct the table string within a code block
				let table = `\`\`\`\n${headerLine}\n${separatorLine}\n${rows.join("\n")}\n`;

				// Add truncation notice if necessary
				if (result.length > this.MAX_RESULT_ROWS) {
					const remainingRows = result.length - this.MAX_RESULT_ROWS;
					table += `... and ${remainingRows} more row${remainingRows > 1 ? "s" : ""} [truncated]\n`;
				}

				table += "```";
				console.log(`[${new Date().toISOString()}] Formatted as table.`); // LOG: Table format
				return table;
			}

			// Fallback to JSON stringification for other types, ensuring escape
			const jsonString = JSON.stringify(result, null, 2); // Pretty print JSON
			// Escape the *entire* JSON string content for MarkdownV2
			const escapedJson = this.escapeMarkdownV2(
				this.truncateString(jsonString, 1000), // Truncate before escaping
			);
			console.log(`[${new Date().toISOString()}] Formatted as JSON.`); // LOG: JSON format
			return `\`\`\`json\n${escapedJson}\n\`\`\``;
		} catch (error) {
			console.error("Error formatting tool result:", error);
			// Provide a generic, escaped fallback message
			return this.escapeMarkdownV2(
				`[Complex data structure - ${typeof result}]`,
			);
		}
	}

	// Edits the last message or sends a new one if needed/too long
	private async updateStatusMessage(
		chatId: number,
		messageId: number,
		text: string, // Expect raw text here
	): Promise<number> {
		if (this.isShuttingDown) return messageId; // Don't edit if shutting down
		// LOG: Updating status message
		console.log(
			`[${new Date().toISOString()}] Updating status message ${messageId} in chat ${chatId}.`,
		);

		try {
			// Ensure text is escaped and truncated *before* sending
			const escapedText = this.escapeMarkdownV2(text);
			const truncatedText = this.truncateString(
				escapedText,
				this.MAX_MESSAGE_LENGTH,
			);

			// Prevent editing with empty or whitespace-only content
			if (truncatedText.trim() === "") {
				console.log(
					`[${new Date().toISOString()}] Skipping status update: empty content.`,
				); // LOG: Skip empty
				return messageId;
			}

			await this.bot.editMessageText(truncatedText, {
				chat_id: chatId,
				message_id: messageId,
				parse_mode: "MarkdownV2", // Ensure parse mode is set
			});
			console.log(
				`[${new Date().toISOString()}] Successfully updated status message ${messageId}.`,
			); // LOG: Success
			return messageId;
		} catch (error: unknown) {
			// Check specifically for 'message is not modified' error
			if (
				typeof error === "object" &&
				error !== null &&
				"response" in error &&
				typeof error.response === "object" &&
				error.response !== null &&
				"body" in error.response &&
				typeof error.response.body === "object" &&
				error.response.body !== null &&
				"description" in error.response.body &&
				typeof error.response.body.description === "string" &&
				error.response.body.description.includes("message is not modified")
			) {
				// Ignore this specific error silently
				console.log(
					`[${new Date().toISOString()}] Status message ${messageId} not modified.`,
				); // LOG: Not modified
				return messageId;
			}

			// Ignore other errors if shutting down (e.g., message to edit not found)
			if (this.isShuttingDown) {
				console.log(
					`[${new Date().toISOString()}] Ignoring status update error during shutdown.`,
				); // LOG: Ignore during shutdown
				return messageId;
			}

			// Log other errors for debugging, but don't crash the bot
			console.warn(
				`[${new Date().toISOString()}] Failed to edit status message ${messageId}:`,
				error instanceof Error ? error.message : String(error),
			); // LOG: Edit failure
			return messageId; // Return original ID if edit failed
		}
	}

	// Appends text to the main response message, handling updates and length limits
	private async appendToMainResponse(
		chatId: number,
		messageId: number,
		currentFullResponse: string, // This should be the already escaped message content
		textToAppend: string, // This should be the already escaped chunk to append
	): Promise<{ updatedMessageId: number; updatedFullResponse: string }> {
		if (this.isShuttingDown) {
			// Don't attempt appends during shutdown
			console.log(
				`[${new Date().toISOString()}] Ignoring appendToMainResponse during shutdown.`,
			); // LOG: Ignore during shutdown
			return {
				updatedMessageId: messageId,
				updatedFullResponse: currentFullResponse,
			};
		}

		// LOG: Appending to main response
		console.log(
			`[${new Date().toISOString()}] Appending to message ${messageId} in chat ${chatId}.`,
		);

		// Concatenate the already escaped parts
		const newFullResponse = currentFullResponse + textToAppend;

		// Check length *before* attempting edit
		if (newFullResponse.length <= this.MAX_MESSAGE_LENGTH) {
			// Prevent editing with identical content to avoid "message is not modified" error when possible
			if (newFullResponse === currentFullResponse) {
				console.log(
					`[${new Date().toISOString()}] Skipping append: content identical.`,
				); // LOG: Skip identical
				return {
					updatedMessageId: messageId,
					updatedFullResponse: currentFullResponse,
				};
			}

			try {
				// Attempt to edit the message with the new combined content
				console.log(
					`[${new Date().toISOString()}] Attempting to edit message ${messageId} with new content.`,
				); // LOG: Attempt edit
				await this.bot.editMessageText(newFullResponse, {
					chat_id: chatId,
					message_id: messageId,
					parse_mode: "MarkdownV2", // Ensure parse mode is set
				});
				console.log(
					`[${new Date().toISOString()}] Successfully edited message ${messageId}.`,
				); // LOG: Edit success
				return {
					updatedMessageId: messageId,
					updatedFullResponse: newFullResponse,
				};
			} catch (error: unknown) {
				// Handle 'message is not modified' error gracefully
				if (
					typeof error === "object" &&
					error !== null &&
					"response" in error &&
					typeof error.response === "object" &&
					error.response !== null &&
					"body" in error.response &&
					typeof error.response.body === "object" &&
					error.response.body !== null &&
					"description" in error.response.body &&
					typeof error.response.body.description === "string" &&
					error.response.body.description.includes("message is not modified")
				) {
					// Message is identical, no actual update needed, return current state
					console.log(
						`[${new Date().toISOString()}] Message ${messageId} not modified (caught during edit).`,
					); // LOG: Not modified (edit)
					return {
						updatedMessageId: messageId,
						updatedFullResponse: currentFullResponse, // Return the original if no change
					};
				}

				// Ignore other errors if shutting down
				if (this.isShuttingDown) {
					console.log(
						`[${new Date().toISOString()}] Ignoring message edit error during shutdown.`,
					); // LOG: Ignore edit error shutdown
					return {
						updatedMessageId: messageId,
						updatedFullResponse: currentFullResponse,
					};
				}

				// Log other edit errors
				console.error(
					`[${new Date().toISOString()}] Error updating main message ${messageId} (edit attempt):`,
					error instanceof Error ? error.message : String(error),
				); // LOG: Edit failure
				// Fall through to sending a new message if update failed for other reasons
			}
		} else {
			console.log(
				`[${new Date().toISOString()}] New content exceeds max length (${newFullResponse.length}/${this.MAX_MESSAGE_LENGTH}). Sending new message.`,
			); // LOG: Exceeds length
		}

		// If message is too long OR the edit failed for reasons other than "not modified"
		// Send the appended part as a *new* message.
		// Ensure the textToAppend (which is already escaped) is also truncated if needed.
		const truncatedAppend = this.truncateString(
			textToAppend,
			this.MAX_MESSAGE_LENGTH,
		);

		// Prevent sending empty or whitespace-only messages
		if (truncatedAppend.trim() === "") {
			console.log(
				`[${new Date().toISOString()}] Skipping sending new message: appended content is empty after truncation.`,
			); // LOG: Skip empty append
			return {
				updatedMessageId: messageId,
				updatedFullResponse: currentFullResponse,
			};
		}

		try {
			console.log(
				`[${new Date().toISOString()}] Sending new continuation message in chat ${chatId}.`,
			); // LOG: Send new message
			const continuationMessage = await this.bot.sendMessage(
				chatId,
				truncatedAppend, // Send the (potentially truncated) new part
				{ parse_mode: "MarkdownV2" }, // Ensure parse mode is set
			);
			console.log(
				`[${new Date().toISOString()}] Successfully sent new message ${continuationMessage.message_id}.`,
			); // LOG: Send new success
			// The new message ID is now the one to track
			// The 'full response' conceptually resets to this new message content
			return {
				updatedMessageId: continuationMessage.message_id,
				updatedFullResponse: truncatedAppend, // The content of the latest message
			};
		} catch (error) {
			// Ignore errors sending messages during shutdown
			if (this.isShuttingDown) {
				console.log(
					`[${new Date().toISOString()}] Ignoring send message error during shutdown.`,
				); // LOG: Ignore send error shutdown
				return {
					updatedMessageId: messageId,
					updatedFullResponse: currentFullResponse,
				};
			}

			console.error(
				`[${new Date().toISOString()}] Error sending continuation message:`,
				error instanceof Error ? error.message : String(error),
			); // LOG: Send new failure
			// If sending the continuation fails, return the last known good state
			return {
				updatedMessageId: messageId,
				updatedFullResponse: currentFullResponse,
			};
		}
	}

	private async handleMessage(msg: TelegramBot.Message) {
		// LOG: Start handleMessage
		console.log(
			`[${new Date().toISOString()}] --- Starting handleMessage for msg ID ${msg.message_id} ---`,
		);
		// If we received a message *after* shutdown started, ignore it.
		// (This check is belt-and-suspenders with the check in the 'message' event handler)
		if (this.isShuttingDown) {
			console.log(
				`[${new Date().toISOString()}] handleMessage: Ignoring due to shutdown flag.`,
			); // LOG: Ignore (shutdown flag)
			return;
		}

		const chatId = msg.chat.id;
		const text = msg.text; // User input doesn't need escaping here
		const username = msg.from?.username || "unknown";
		// Store raw first name, escape only when needed for display/sending
		const rawFirstName = msg.from?.first_name || "unknown";
		const resourceId = msg.from?.id
			? `telegram-${msg.from.id}`
			: `telegram-anonymous-${chatId}`;
		const threadId = `telegram-${chatId}`; // One thread per chat

		// LOG: Basic message details
		console.log(
			`[${new Date().toISOString()}] Chat ID: ${chatId}, User: ${username} (${rawFirstName}), Text: "${text}"`,
		);

		if (!text) {
			// Handle non-text messages (optional)
			console.log(
				`[${new Date().toISOString()}] Received non-text message, sending reply.`,
			); // LOG: Non-text received
			await this.bot.sendMessage(
				chatId,
				this.escapeMarkdownV2(
					"Sorry, I can only process text messages right now.",
				),
				{ parse_mode: "MarkdownV2" },
			);
			return;
		}

		// --- Command Handling ---
		if (text.startsWith("/")) {
			const command = text.split(" ")[0];
			console.log(
				`[${new Date().toISOString()}] Processing command: ${command}`,
			); // LOG: Command processing
			if (command === "/start") {
				// Construct the raw message *without* manual escapes
				const rawWelcomeMessage = `Hello ${rawFirstName}! I'm Zara, your AI assistant for luxury real estate in Dubai. How can I help you find your perfect property today?`;
				// Escape the *entire* message for MarkdownV2 just before sending
				const escapedWelcomeMessage = this.escapeMarkdownV2(rawWelcomeMessage);
				console.log(
					`[${new Date().toISOString()}] Sending /start response to chat ${chatId}.`,
				); // LOG: Send /start
				await this.bot.sendMessage(chatId, escapedWelcomeMessage, {
					parse_mode: "MarkdownV2",
				});
				return;
			}
			if (command === "/reset") {
				// TODO: Implement proper memory clearing when available in Mastra Agent
				const resetMessage = this.escapeMarkdownV2(
					"Ok, I've reset our conversation context (Note: Full memory reset pending implementation). What would you like to discuss now?",
				);
				console.log(
					`[${new Date().toISOString()}] Sending /reset response to chat ${chatId}.`,
				); // LOG: Send /reset
				await this.bot.sendMessage(chatId, resetMessage, {
					parse_mode: "MarkdownV2",
				});
				return;
			}
			// Optional: Handle unknown commands
			const unknownCmdMsg = this.escapeMarkdownV2(
				`Sorry, I don't recognize the command: ${command}`,
			);
			console.log(
				`[${new Date().toISOString()}] Sending unknown command response to chat ${chatId}.`,
			); // LOG: Send unknown cmd
			await this.bot.sendMessage(chatId, unknownCmdMsg, {
				parse_mode: "MarkdownV2",
			});
			return;
		}

		// --- Message Processing ---
		let statusMessageText = "🧠 Thinking..."; // Raw status text
		let mainResponseMessageContent = ""; // Accumulates the final *escaped* response text
		let mainResponseMsgId: number | undefined = undefined;
		let statusMsgId: number | undefined = undefined;
		// LOG: Start message processing block
		console.log(
			`[${new Date().toISOString()}] Entering main message processing block.`,
		);

		try {
			// Send initial status message (escape happens in sendMessage wrapper/updateStatusMessage)
			console.log(
				`[${new Date().toISOString()}] Sending initial status message to chat ${chatId}.`,
			); // LOG: Send initial status
			const initialStatusMsg = await this.bot.sendMessage(
				chatId,
				this.escapeMarkdownV2(statusMessageText), // Escape initial status here
				{ parse_mode: "MarkdownV2" },
			);
			console.log(
				`[${new Date().toISOString()}] Initial status message sent (ID: ${initialStatusMsg.message_id}).`,
			); // LOG: Initial status sent

			// Check if we are shutting down *immediately* after sending
			if (this.isShuttingDown) {
				console.log(
					`[${new Date().toISOString()}] Aborting processing: shutdown occurred after sending initial status.`,
				); // LOG: Abort after initial send
				return;
			}

			statusMsgId = initialStatusMsg.message_id;
			mainResponseMsgId = statusMsgId; // Start tracking the main message ID
			// The initial content of the main message is the escaped status
			mainResponseMessageContent = this.escapeMarkdownV2(statusMessageText);

			// LOG: Calling agent stream
			console.log(
				`[${new Date().toISOString()}] Calling realEstateAgent.stream with threadId: ${threadId}`,
			);
			const stream = await realEstateAgent.stream(text, {
				// Use raw text input
				threadId: threadId,
				resourceId: resourceId,
				context: [
					{
						role: "system",
						// Provide raw names, agent internally decides how to use them
						content: `User info: Name=${rawFirstName}, Username=${username}`,
					},
				],
			});
			console.log(`[${new Date().toISOString()}] Agent stream obtained.`); // LOG: Stream obtained

			// LOG: Starting stream processing loop
			console.log(
				`[${new Date().toISOString()}] Starting to process agent stream chunks...`,
			);
			for await (const chunk of stream.fullStream) {
				// LOG: Received stream chunk
				console.log(
					`[${new Date().toISOString()}] Received stream chunk: ${JSON.stringify(chunk)}`,
				);
				// Check if shutdown initiated during stream processing
				if (this.isShuttingDown) {
					console.log(
						`[${new Date().toISOString()}] Breaking stream loop due to shutdown.`,
					); // LOG: Break loop (shutdown)
					break;
				}

				let escapedChunkContent = ""; // Store the fully processed and escaped content for this chunk

				switch (chunk.type) {
					case "text-delta":
						escapedChunkContent = this.escapeMarkdownV2(chunk.textDelta);
						// Ensure status is back to thinking (raw text) if needed
						if (statusMessageText !== "🧠 Thinking...") {
							console.log(
								`[${new Date().toISOString()}] Resetting status to 'Thinking...' due to text-delta.`,
							); // LOG: Reset status
							statusMessageText = "🧠 Thinking...";
							if (statusMsgId) {
								// updateStatusMessage handles escaping internally
								await this.updateStatusMessage(
									chatId,
									statusMsgId,
									statusMessageText,
								);
							}
						}
						break;

					case "tool-call": {
						const toolName = chunk.toolName ?? "unknown_tool";
						const argsString = this.truncateString(
							JSON.stringify(chunk.args ?? {}),
							200,
						);
						// Update status message text (raw)
						statusMessageText = `🛠️ Using tool: *${toolName}*...`; // Use raw * for emphasis here
						console.log(
							`[${new Date().toISOString()}] Updating status for tool call: ${toolName}`,
						); // LOG: Update status (tool call)
						if (statusMsgId) {
							// updateStatusMessage handles escaping the raw status text
							await this.updateStatusMessage(
								chatId,
								statusMsgId,
								statusMessageText,
							);
						}
						// Prepare escaped text for the main response body
						escapedChunkContent = `\n*(Using tool: ${this.escapeMarkdownV2(toolName)} with args: \`${this.escapeMarkdownV2(argsString)}\`)*\n`;
						console.log(
							`[${new Date().toISOString()}] Tool call logged: ${toolName}`,
							chunk.args,
						); // LOG: Tool call details
						break;
					}

					case "tool-result": {
						const toolName = chunk.toolName ?? "unknown_tool";
						// formatToolResult already returns an escaped string
						const formattedResult = this.formatToolResult(chunk.result); // Is already escaped
						// Assemble the final string, escaping only the parts that need it
						escapedChunkContent = `\n✨ Result from *${this.escapeMarkdownV2(toolName)}*:\n${formattedResult}\n`; // formattedResult is pre-escaped
						console.log(
							`[${new Date().toISOString()}] Tool result received for: ${toolName}`,
							chunk.result,
						); // LOG: Tool result details
						// Update status message text back to thinking (raw)
						statusMessageText = "🧠 Thinking...";
						console.log(
							`[${new Date().toISOString()}] Resetting status to 'Thinking...' after tool result.`,
						); // LOG: Reset status (tool result)
						if (statusMsgId) {
							// updateStatusMessage handles escaping
							await this.updateStatusMessage(
								chatId,
								statusMsgId,
								statusMessageText,
							);
						}
						break;
					}

					case "error":
						// Escape the error message itself before including it
						escapedChunkContent = `\n❌ Error: ${this.escapeMarkdownV2(String(chunk.error))}\n`;
						console.error(
							`[${new Date().toISOString()}] Stream Error chunk:`,
							chunk.error,
						); // LOG: Stream error chunk
						statusMessageText = "⚠️ Error encountered"; // Raw status
						if (statusMsgId) {
							// updateStatusMessage handles escaping
							await this.updateStatusMessage(
								chatId,
								statusMsgId,
								statusMessageText,
							);
						}
						break;

					// Skip reasoning for cleaner output by default
					// case "reasoning":
					//  escapedChunkContent = this.escapeMarkdownV2(`\n💭 ${chunk.textDelta}`);
					//  console.log("Reasoning:", chunk.textDelta);
					//  break;
				}

				// Append the *escaped* text chunk if it's not empty and we have a message ID
				if (escapedChunkContent && mainResponseMsgId) {
					// LOG: Before appendToMainResponse call
					console.log(
						`[${new Date().toISOString()}] Calling appendToMainResponse for message ${mainResponseMsgId}.`,
					);
					const { updatedMessageId, updatedFullResponse } =
						await this.appendToMainResponse(
							chatId,
							mainResponseMsgId,
							mainResponseMessageContent, // Pass the current *escaped* message content
							escapedChunkContent, // Pass the *escaped* chunk content
						);
					mainResponseMsgId = updatedMessageId;
					mainResponseMessageContent = updatedFullResponse; // Update with the new *escaped* total
					// LOG: After appendToMainResponse call
					console.log(
						`[${new Date().toISOString()}] appendToMainResponse finished. New message ID: ${mainResponseMsgId}.`,
					);
				} else {
					// LOG: Skipping append (empty chunk or no message ID)
					console.log(
						`[${new Date().toISOString()}] Skipping append: Chunk empty or mainResponseMsgId missing (${!escapedChunkContent}, ${!mainResponseMsgId}).`,
					);
				}
			}
			// LOG: Finished processing stream loop
			console.log(
				`[${new Date().toISOString()}] Finished processing agent stream chunks.`,
			);

			// --- Final Cleanup --- (Skip if shutting down)
			if (this.isShuttingDown) {
				console.log(
					`[${new Date().toISOString()}] Skipping final cleanup due to shutdown.`,
				); // LOG: Skip cleanup (shutdown)
				return;
			}
			console.log(
				`[${new Date().toISOString()}] Entering final cleanup phase...`,
			); // LOG: Enter cleanup

			// Determine if the status message needs deletion.
			const isFinalMessageJustInitialStatus =
				mainResponseMsgId === statusMsgId &&
				mainResponseMessageContent === this.escapeMarkdownV2("🧠 Thinking...");
			console.log(
				`[${new Date().toISOString()}] Final cleanup check: statusMsgId=${statusMsgId}, mainResponseMsgId=${mainResponseMsgId}, isFinalMessageJustInitialStatus=${isFinalMessageJustInitialStatus}`,
			); // LOG: Cleanup check vars

			if (
				statusMsgId &&
				statusMsgId !== mainResponseMsgId &&
				!isFinalMessageJustInitialStatus
			) {
				try {
					console.log(
						`[${new Date().toISOString()}] Deleting status message ${statusMsgId} as it differs from main message ${mainResponseMsgId}.`,
					); // LOG: Delete status msg
					await this.bot.deleteMessage(chatId, statusMsgId);
				} catch (delError) {
					console.warn(
						`[${new Date().toISOString()}] Minor error deleting final status message ${statusMsgId}:`,
						delError,
					); // LOG: Delete status error
				}
			}

			// If, after processing, the main response message *still* only contains the initial "Thinking...",
			// and no stream error occurred, update it to a more informative final message.
			if (
				isFinalMessageJustInitialStatus &&
				!mainResponseMessageContent.includes(this.escapeMarkdownV2("Error:"))
			) {
				const finalMsgText = "Finished processing. How else can I assist?";
				const finalMsg = this.escapeMarkdownV2(finalMsgText);
				console.log(
					`[${new Date().toISOString()}] Main message ${mainResponseMsgId} only contains initial status; updating.`,
				); // LOG: Update final empty status
				if (mainResponseMsgId) {
					// Should always be true here, but check for safety
					try {
						await this.updateStatusMessage(
							chatId,
							mainResponseMsgId,
							finalMsgText, // Pass raw text
						);
						console.log(
							`[${new Date().toISOString()}] Successfully updated final empty status message ${mainResponseMsgId}.`,
						); // LOG: Update success
					} catch (finalUpdateError) {
						console.error(
							`[${new Date().toISOString()}] Error updating final empty status message ${mainResponseMsgId}:`,
							finalUpdateError,
						); // LOG: Update final error
						// Fallback: send a new message if editing fails
						try {
							console.log(
								`[${new Date().toISOString()}] Sending fallback final message to chat ${chatId}.`,
							); // LOG: Send fallback final
							await this.bot.sendMessage(chatId, finalMsg, {
								parse_mode: "MarkdownV2",
							});
						} catch (fallbackSendError) {
							console.error(
								`[${new Date().toISOString()}] Error sending fallback final message:`,
								fallbackSendError,
							); // LOG: Send fallback error
						}
					}
				}
			}
			console.log(
				`[${new Date().toISOString()}] --- Finished handleMessage for msg ID ${msg.message_id} ---`,
			); // LOG: End handleMessage
		} catch (error) {
			// Ignore errors if they happen during shutdown phase
			if (this.isShuttingDown) {
				console.log(
					`[${new Date().toISOString()}] Ignoring critical error during shutdown.`,
				); // LOG: Ignore critical error shutdown
				return;
			}

			// LOG: Critical error in handleMessage try block
			console.error(
				`[${new Date().toISOString()}] Critical error in handleMessage for chat ${chatId} (msg ID ${msg.message_id}):`,
				error, // Log the full error object
			);
			// Attempt to clean up status message even in case of outer errors
			if (statusMsgId) {
				try {
					console.log(
						`[${new Date().toISOString()}] Attempting to delete status message ${statusMsgId} after critical error.`,
					); // LOG: Delete status after error
					await this.bot.deleteMessage(chatId, statusMsgId);
				} catch (delError) {
					console.warn(
						`[${new Date().toISOString()}] Failed to delete status message ${statusMsgId} after critical error:`,
						delError,
					); // LOG: Delete status after error failed
				}
			}
			// Send a generic error message to the user, ensuring it's escaped
			const errorMsg = this.escapeMarkdownV2(
				"😥 Sorry, a critical error occurred while processing your request. Please try again later.",
			);
			try {
				console.log(
					`[${new Date().toISOString()}] Sending critical error message to chat ${chatId}.`,
				); // LOG: Send critical error msg
				await this.bot.sendMessage(chatId, errorMsg, {
					parse_mode: "MarkdownV2",
				});
			} catch (sendError) {
				console.error(
					`[${new Date().toISOString()}] Failed to send critical error message to user ${chatId}:`,
					sendError,
				); // LOG: Send critical error msg failed
			}
		}
	}
}
