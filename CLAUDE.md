# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands
- Build: `pnpm run build`
- Development: `pnpm run dev`
- Deploy: `pnpm run deploy`
- Test: `vitest` or `vitest run path/to/test.spec.ts` for single test
- Lint: Not configured (consider adding ESLint)

## Style Guidelines
- **Imports**: Group by external/internal, alphabetical order
- **Types**: Use TypeScript strict mode with proper type annotations
- **Formatting**: Follow TypeScript standard formatting
- **Naming**: 
  - camelCase for variables/functions
  - PascalCase for classes/interfaces/types
  - Use descriptive names
- **Error Handling**: Properly type and handle errors
- **Project Structure**: 
  - Use modules in `src/mastra/` directory
  - Agents defined in `src/mastra/agents/`
  - Knowledge base in `src/knowledge/`

## Environment
Cloudflare Workers-based application using Mastra framework