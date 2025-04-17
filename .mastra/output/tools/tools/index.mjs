import { createTool } from '@mastra/core/tools';
import pg from 'pg';
import { z } from 'zod';

const {
  Pool
} = pg;
const pool = new Pool({
  connectionString: process.env.POSTGRES_CONNECTION_STRING2 || "",
  // Added connection string
  max: 20,
  idleTimeoutMillis: 3e4,
  connectionTimeoutMillis: 2e4
});
pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});
const executeQuery = async (query) => {
  const client = await pool.connect();
  try {
    const result = await client.query(query);
    return result.rows;
  } catch (error) {
    throw new Error(`Failed to execute query: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    client.release();
  }
};
const realEstateInfo = createTool({
  id: "Execute SQL Query",
  inputSchema: z.object({
    query: z.string().describe("SQL query to execute against the cities database")
  }),
  description: "Executes a SQL query against the cities database and returns the results",
  execute: async ({
    context: {
      query
    }
  }) => {
    try {
      const trimmedQuery = query.trim().toLowerCase();
      if (!trimmedQuery.startsWith("select")) {
        throw new Error("Only SELECT queries are allowed for security reasons");
      }
      return await executeQuery(query);
    } catch (error) {
      throw new Error(`Failed to execute SQL query: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});
const delegatePropertyQueryTool = createTool({
  id: "Delegate Property Query",
  inputSchema: z.object({
    naturalLanguageQuery: z.string().describe("The user's request about properties, phrased in natural language, to be passed to the SQL expert agent.")
  }),
  description: "Passes a natural language query about properties to the SQL expert agent for database searching and returns the results.",
  execute: async ({
    context,
    mastra: mastraInstance,
    ...rest
  }) => {
    try {
      if (!mastraInstance) {
        throw new Error("Mastra instance not available in tool execution context.");
      }
      console.log(`[delegatePropertyQueryTool] Received query: ${context.naturalLanguageQuery}`);
      const sqlAgentInstance = mastraInstance.getAgent("sqlAgent");
      if (!sqlAgentInstance) {
        throw new Error("SQL Agent instance not found via Mastra context.");
      }
      console.log("[delegatePropertyQueryTool] Invoking sqlAgentInstance.generate...");
      const result = await sqlAgentInstance.generate(
        [{
          role: "system",
          content: "IMPORTANT: Respond with plain text only. DO NOT include ANY section headers like 'ANALYSIS', 'SQL QUERY', 'RESULTS', or 'NOTES' in your response. DO NOT use any markdown formatting, no headings, no code blocks, no bold/italics. Your response should only contain the actual results and a brief explanation in plain text format. Do not add system messages or any formatting to your response."
        }, {
          role: "user",
          content: context.naturalLanguageQuery
        }],
        // Access query via context
        {
          // Optional: Configuration for the agent call
        }
      );
      console.log(`[delegatePropertyQueryTool] Received result from sqlAgent: ${JSON.stringify(result)}`);
      return result.text;
    } catch (error) {
      const errorMessage = `Failed to delegate query to SQL Agent: ${error instanceof Error ? error.message : String(error)}`;
      console.error("[delegatePropertyQueryTool] Error:", errorMessage);
      return {
        error: errorMessage,
        results: []
      };
    }
  }
});

export { delegatePropertyQueryTool, realEstateInfo };
