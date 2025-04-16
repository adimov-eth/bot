import { openai } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "@ai-sdk/provider";
import { Agent } from "@mastra/core/agent";
import * as tools from "../tools";

const DB_SCHEMA = `

  DATABASE SCHEMA:

  CREATE TABLE emirates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    geometry JSONB,
    entity TEXT
  );

  CREATE TABLE districts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT,
    emirate_id INTEGER REFERENCES emirates(id),
    cost_level INTEGER,
    geometry JSONB,
    entity TEXT,
    metrics JSONB
  );

  CREATE TABLE companies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT,
    logo_id TEXT,
    projects_count INTEGER,
    contact_name TEXT,
    contact_phone TEXT,
    address TEXT,
    logo JSONB,
    site TEXT,
    commission_min DOUBLE PRECISION,
    commission_max DOUBLE PRECISION,
    commission DOUBLE PRECISION,
    expired_at TIMESTAMP WITHOUT TIME ZONE,
    max_users_count INTEGER,
    max_resale_units INTEGER,
    has_resale_access BOOLEAN,
    registration JSONB
  );

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    district_id INTEGER REFERENCES districts(id),
    developer_id INTEGER REFERENCES companies(id),
    seller_id INTEGER REFERENCES companies(id),
    service_charge DOUBLE PRECISION,
    geometry JSONB,
    point4326 JSONB,
    handover DATE,
    has_post_handover BOOLEAN,
    has_resale BOOLEAN,
    has_off_plan BOOLEAN,
    square_min DOUBLE PRECISION,
    square_max DOUBLE PRECISION,
    price_min DOUBLE PRECISION,
    price_max DOUBLE PRECISION,
    is_launch BOOLEAN,
    start_of_sales DATE,
    eoi JSONB,
    noc JSONB,
    units_updated_at TIMESTAMP WITHOUT TIME ZONE,
    metrics JSONB,
    status TEXT,
    dld_number TEXT,
    entity TEXT
  );

  CREATE TABLE unit_types (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE unit_layouts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE units (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number TEXT,
    price DOUBLE PRECISION,
    square DOUBLE PRECISION,
    height TEXT,
    floor TEXT,
    type_id INTEGER REFERENCES unit_types(id),
    layout_id INTEGER REFERENCES unit_layouts(id),
    type_of_sale TEXT,
    status TEXT,
    views JSONB,
    price_per_square_foot DOUBLE PRECISION,
    last_price_change JSONB
  );

  CREATE TABLE payment_plans (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    post_handover BOOLEAN,
    down_payment DOUBLE PRECISION
  );

  CREATE TABLE payment_plan_items (
    id INTEGER PRIMARY KEY,
    payment_plan_id INTEGER NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT
  );

`;

export const sqlAgent = new Agent({
	name: "SQL Agent",
	instructions: `You are a SQL (PostgreSQL) expert for a database of real estate properties in Dubai. Generate and execute queries that answer user questions about available properties.
    ${DB_SCHEMA}

    QUERY GUIDELINES:
    - **Retrieval Only:** Generate ONLY SELECT statements. Do not attempt INSERT, UPDATE, or DELETE.
    - **Country Names:** Use full names like "United Kingdom" or "United States" if filtering by location implicitly.
    - **Current Data:** The database reflects the current state; historical trend queries are not supported.
    - **Visualization Focus:** Aim to return at least two columns suitable for tables or charts. If the user requests a single attribute, consider returning that attribute along with a count (e.g., SELECT district_name, COUNT(*) FROM projects GROUP BY district_name).
    - **Rate Formatting:** Represent rates as decimals (e.g., 0.05 for 5%).
    - **Targeted Queries:** Focus on relevant columns like \`projects.status\`, \`projects.handover\`, \`projects.price_min\`, \`projects.price_max\`, \`projects.square_min\`, \`projects.square_max\`, \`projects.has_resale\`, \`projects.has_off_plan\`, \`units.price\`, \`units.square\`, \`units.status\`, \`districts.name\`, \`companies.name\`.
    - **Joins:** Use JOIN clauses (specifically INNER JOIN or LEFT JOIN as appropriate) to combine data from related tables (e.g., \`projects\` with \`districts\`, \`companies\`, or \`units\`).
    - **Filtering:** Use the WHERE clause effectively. For text searches, prefer \`ILIKE\` for case-insensitivity (e.g., \`WHERE districts.name ILIKE '%marina%'\`). Use appropriate operators for numeric (\`=\`, \`>\`, \`<\`, \`BETWEEN\`) and date comparisons.
    - **Clarity:** Prefer clear, straightforward queries. Avoid overly complex subqueries if a JOIN or simpler filter achieves the same result.

    SQL FORMATTING:
    - **Keywords:** Use consistent uppercase for SQL keywords (SELECT, FROM, WHERE, JOIN, GROUP BY, ORDER BY, etc.).
    - **Line Breaks:** Start main clauses (SELECT, FROM, WHERE, GROUP BY, ORDER BY) on new lines. Place each JOIN clause on a new line.
    - **Indentation:** Indent subqueries, JOIN conditions (ON), and items within clauses (e.g., columns in SELECT, conditions in WHERE) for readability.
    - **Alignment:** Align related items vertically where it enhances clarity (e.g., multiple conditions in a WHERE clause).

    WORKFLOW & OUTPUT TEMPLATE:
    1.  **Analyze:** Carefully read the user's question to understand the specific information requested about Dubai real estate.
    2.  **Plan Query:** Determine the necessary tables, columns, joins, and filters based on the database schema and query guidelines.
    3.  **Generate SQL:** Construct the SQL query following the formatting guidelines.
    4.  **Execute:** Use the provided SQL execution tool to run the query against the database.
    5.  **Format Output:** Present the results clearly in markdown using the following template:

        ### Analysis
        [Briefly explain how the user's request translates to the database query. Mention key tables and filters used.]

        ### SQL Query
        \`\`\`sql
        [Paste the exact, well-formatted SQL query that was executed.]
        \`\`\`

        ### Results
        [Display the query results in a markdown table. If no results are found, state "No matching records found."]

        ### Notes
        [Optional: Add any relevant caveats, e.g., "Prices are in AED.", "Data reflects the latest update."]
    `,
	model: openai("gpt-4o") as LanguageModelV1,
	tools: {
		realEstateInfo: tools.realEstateInfo,
	},
});
