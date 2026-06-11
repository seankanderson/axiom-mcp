import { z } from 'zod'

export interface ToolDefinition {
    name:        string
    description: string
    inputSchema: z.ZodType
    handler:     (input: unknown) => Promise<unknown>
}
