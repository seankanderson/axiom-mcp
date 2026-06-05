import { z } from 'zod'

/**
 * Minimal Zod → JSON Schema converter — only covers what our tools need
 * (objects of primitives, arrays, optional/enum/describe). Keeps the runtime
 * dependency surface small.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
    if (schema instanceof z.ZodObject) {
        const properties: Record<string, unknown> = {}
        const required: string[] = []
        for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
            properties[key] = zodToJsonSchema(child)
            if (!(child instanceof z.ZodOptional) && !(child instanceof z.ZodDefault)) {
                required.push(key)
            }
        }
        const result: Record<string, unknown> = { type: 'object', properties }
        if (required.length > 0) result.required = required
        return result
    }
    if (schema instanceof z.ZodString)  return { type: 'string',  description: descOf(schema) }
    if (schema instanceof z.ZodNumber)  return { type: 'number',  description: descOf(schema) }
    if (schema instanceof z.ZodBoolean) return { type: 'boolean', description: descOf(schema) }
    if (schema instanceof z.ZodEnum) {
        return { type: 'string', enum: (schema as z.ZodEnum<[string, ...string[]]>).options }
    }
    if (schema instanceof z.ZodArray) {
        return { type: 'array', items: zodToJsonSchema(schema.element) }
    }
    if (schema instanceof z.ZodOptional) {
        return zodToJsonSchema(schema.unwrap())
    }
    if (schema instanceof z.ZodDefault) {
        return zodToJsonSchema(schema.removeDefault())
    }
    return {}
}

function descOf(s: z.ZodType): string | undefined {
    const desc = (s as { description?: string }).description
    return desc || undefined
}
