import { z } from 'zod'
import { axiomApi } from '../apiClient.js'

// ── Inventory tools ──────────────────────────────────────────────────────────
// Role notes (see role-permissions-matrix.md):
//   view/create/edit/receive: all roles
//   adjust stock:             admin + supervisor only
//   delete item:              admin only

const ListInventoryInput = z.object({
    search:     z.string().optional().describe('Substring match against code, description, or UPC.'),
    category:   z.string().optional().describe('Filter by category name (exact match, case-insensitive).'),
    lowStock:   z.boolean().optional().describe('When true, return only items at or below reorder threshold.'),
    available:  z.boolean().optional().describe('Filter by the available flag on the item.'),
    supplierId: z.string().optional().describe('Filter to items sourced from this supplier contact id.'),
    limit:      z.number().int().positive().max(500).optional().default(100).describe('Max records to return (default 100, max 500).'),
    offset:     z.number().int().min(0).optional().default(0).describe('Number of records to skip for pagination.'),
})

export const listInventory = {
    name: 'list_inventory',
    description:
        'List inventory items (products and services) for the bound company. Supports filtering by search text, category, supplier, low-stock flag, and availability. Paginate with limit and offset.',
    inputSchema: ListInventoryInput,
    handler: async (raw: unknown) => {
        const input = ListInventoryInput.parse(raw)
        const companyId = axiomApi.getCompanyId()

        const params = new URLSearchParams()
        if (input.search)                    params.set('search',     input.search)
        if (input.category)                  params.set('category',   input.category)
        if (input.supplierId)                params.set('supplierId', input.supplierId)
        if (input.lowStock)                  params.set('lowStock',   'true')
        if (input.available !== undefined)   params.set('available',  String(input.available))
        params.set('limit',  String(input.limit  ?? 100))
        params.set('offset', String(input.offset ?? 0))

        const path = `/companies/${companyId}/inventory?${params.toString()}`
        return await axiomApi.get(path)
    },
}

const GetInventoryItemInput = z.object({
    itemId: z.string().describe('Inventory item id.'),
})

export const getInventoryItem = {
    name: 'get_inventory_item',
    description: 'Fetch a single inventory item by id, including stock levels, pricing, and supplier links.',
    inputSchema: GetInventoryItemInput,
    handler: async (raw: unknown) => {
        const { itemId } = GetInventoryItemInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        return await axiomApi.get(`/companies/${companyId}/inventory/${encodeURIComponent(itemId)}`)
    },
}

const UpdateInventoryItemInput = z.object({
    itemId:      z.string().describe('Id of the item to update.'),
    code:        z.string().optional().describe('Short SKU / item code (unique per company).'),
    description: z.string().optional().describe('Human-readable name / description.'),
    price:       z.number().optional().describe('Unit sale price.'),
    cost:        z.number().optional().describe('Unit cost.'),
    category:    z.string().optional().describe('Category label.'),
    cutoff:      z.number().optional().describe('Reorder threshold quantity.'),
    available:   z.boolean().optional().describe('Whether the item is available for sale.'),
    notes:       z.string().optional().describe('Internal notes.'),
})

export const updateInventoryItem = {
    name: 'update_inventory_item',
    description:
        'Update editable fields of an inventory item. All roles can edit items and pricing. Omit fields to leave them unchanged — the current record is fetched automatically so unchanged fields are preserved.',
    inputSchema: UpdateInventoryItemInput,
    handler: async (raw: unknown) => {
        const input = UpdateInventoryItemInput.parse(raw)
        const companyId = axiomApi.getCompanyId()

        // Fetch the current item so we send a complete PUT body (the API is
        // a full-replacement PUT, not a PATCH).
        const current = await axiomApi.get<{ item?: Record<string, unknown>; data?: Record<string, unknown> }>(
            `/companies/${companyId}/inventory/${encodeURIComponent(input.itemId)}`,
        )
        const existing: Record<string, unknown> =
            (current as { item?: Record<string, unknown> }).item ??
            (current as { data?: Record<string, unknown> }).data ??
            (current as Record<string, unknown>)

        const body: Record<string, unknown> = {
            ...existing,
            ...(input.code        !== undefined && { code:        input.code }),
            ...(input.description !== undefined && { description: input.description }),
            ...(input.price       !== undefined && { price:       input.price }),
            ...(input.cost        !== undefined && { cost:        input.cost }),
            ...(input.category    !== undefined && { category:    input.category }),
            ...(input.cutoff      !== undefined && { cutoff:      input.cutoff }),
            ...(input.available   !== undefined && { available:   input.available }),
            ...(input.notes       !== undefined && { notes:       input.notes }),
        }

        return await axiomApi.put(
            `/companies/${companyId}/inventory/${encodeURIComponent(input.itemId)}`,
            body,
        )
    },
}

const ReceiveInventoryInput = z.object({
    itemId:      z.string().describe('Id of the inventory item to receive stock for.'),
    quantity:    z.number().positive().describe('Number of units received.'),
    paidAmount:  z.number().min(0).optional().describe('Amount paid for this receipt. If >0 a GL entry (Dr Inventory, Cr Cash) is posted. If 0 or omitted, no GL entry is made.'),
    notes:       z.string().optional().describe('Optional notes for the receipt.'),
})

export const receiveInventory = {
    name: 'receive_inventory',
    description:
        'Record stock received for an inventory item. All roles can receive stock. If paidAmount > 0 a matching GL entry is posted automatically.',
    inputSchema: ReceiveInventoryInput,
    handler: async (raw: unknown) => {
        const input = ReceiveInventoryInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        return await axiomApi.post(
            `/companies/${companyId}/inventory/${encodeURIComponent(input.itemId)}/receive`,
            {
                quantity:   input.quantity,
                paidAmount: input.paidAmount ?? 0,
                notes:      input.notes,
            },
        )
    },
}

export const INVENTORY_TOOLS = [
    listInventory,
    getInventoryItem,
    updateInventoryItem,
    receiveInventory,
]
