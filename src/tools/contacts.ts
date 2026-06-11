import { z } from 'zod'
import { axiomApi } from '../apiClient.js'

// ── Contacts tools ───────────────────────────────────────────────────────────
// Role notes (see role-permissions-matrix.md):
//   view:            all roles
//   create / edit:   all roles
//   delete:          admin only

const AddressInput = z.object({
    line1:    z.string().optional(),
    line2:    z.string().optional(),
    city:     z.string().optional(),
    province: z.string().optional(),
    postcode: z.string().optional(),
    country:  z.string().optional(),
})

const ListContactsInput = z.object({
    search:     z.string().optional().describe('Substring match against company name, first/last name, or email.'),
    isCustomer: z.boolean().optional().describe('Filter to customer contacts only.'),
    isSupplier: z.boolean().optional().describe('Filter to supplier contacts only.'),
    limit:      z.number().int().positive().max(500).optional().default(100).describe('Max records to return (default 100, max 500).'),
    offset:     z.number().int().min(0).optional().default(0).describe('Number of records to skip for pagination.'),
})

export const listContacts = {
    name: 'list_contacts',
    description:
        'List contacts (customers and/or suppliers) for the bound company. Supports filtering by name/email search and type. Paginate with limit and offset. Use isCustomer=true or isSupplier=true to narrow by type.',
    inputSchema: ListContactsInput,
    handler: async (raw: unknown) => {
        const input = ListContactsInput.parse(raw)
        const companyId = axiomApi.getCompanyId()

        const params = new URLSearchParams()
        if (input.search)                   params.set('search',     input.search)
        if (input.isCustomer !== undefined) params.set('isCustomer', String(input.isCustomer))
        if (input.isSupplier !== undefined) params.set('isSupplier', String(input.isSupplier))
        params.set('limit',  String(input.limit  ?? 100))
        params.set('offset', String(input.offset ?? 0))

        const path = `/companies/${companyId}/contacts?${params.toString()}`
        return await axiomApi.get(path)
    },
}

const GetContactInput = z.object({
    contactId: z.string().describe('Contact id.'),
})

export const getContact = {
    name: 'get_contact',
    description: 'Fetch a single contact (customer or supplier) by id, including address, phone numbers, and tax info.',
    inputSchema: GetContactInput,
    handler: async (raw: unknown) => {
        const { contactId } = GetContactInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        return await axiomApi.get(`/companies/${companyId}/contacts/${encodeURIComponent(contactId)}`)
    },
}

const CreateContactInput = z.object({
    company:       z.string().optional().describe('Business / company name (use for business contacts).'),
    firstName:     z.string().optional().describe('First name (for individual contacts).'),
    lastName:      z.string().optional().describe('Last name (for individual contacts).'),
    email:         z.string().email().optional(),
    isCustomer:    z.boolean().optional().default(false),
    isSupplier:    z.boolean().optional().default(false),
    address:       AddressInput.optional(),
    phone:         z.string().optional().describe('Primary phone number.'),
    notes:         z.string().optional(),
})

export const createContact = {
    name: 'create_contact',
    description:
        'Create a new contact. At least one of company, firstName, or lastName is required. Set isCustomer and/or isSupplier to classify the contact. All roles can create contacts.',
    inputSchema: CreateContactInput,
    handler: async (raw: unknown) => {
        const input = CreateContactInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        return await axiomApi.post(`/companies/${companyId}/contacts`, input)
    },
}

const UpdateContactInput = z.object({
    contactId:     z.string().describe('Id of the contact to update.'),
    company:       z.string().optional(),
    firstName:     z.string().optional(),
    lastName:      z.string().optional(),
    email:         z.string().email().optional(),
    isCustomer:    z.boolean().optional(),
    isSupplier:    z.boolean().optional(),
    address:       AddressInput.optional(),
    phone:         z.string().optional(),
    notes:         z.string().optional(),
})

export const updateContact = {
    name: 'update_contact',
    description:
        'Update editable fields of a contact. All roles can edit contacts. Omit a field to leave it unchanged — the current record is fetched automatically so unchanged fields are preserved.',
    inputSchema: UpdateContactInput,
    handler: async (raw: unknown) => {
        const input = UpdateContactInput.parse(raw)
        const companyId = axiomApi.getCompanyId()

        // Fetch current so we can send a complete PUT body (full-replacement).
        const current = await axiomApi.get<Record<string, unknown>>(
            `/companies/${companyId}/contacts/${encodeURIComponent(input.contactId)}`,
        )
        // Unwrap envelope if present.
        const existing: Record<string, unknown> =
            (current as { contact?: Record<string, unknown> }).contact ??
            (current as { data?: Record<string, unknown> }).data ??
            current

        const { contactId, ...fields } = input
        const body: Record<string, unknown> = {
            ...existing,
            ...Object.fromEntries(
                Object.entries(fields).filter(([, v]) => v !== undefined),
            ),
        }

        return await axiomApi.put(
            `/companies/${companyId}/contacts/${encodeURIComponent(contactId)}`,
            body,
        )
    },
}

export const CONTACT_TOOLS = [
    listContacts,
    getContact,
    createContact,
    updateContact,
]
